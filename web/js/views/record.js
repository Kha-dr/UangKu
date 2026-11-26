import { JENIS_TRANSAKSI } from '../config.js';
import { escapeHtml, formatID, parseIDNumber, formatDBDate, showAlert, ensureSlimSelect, ensurePdfJs } from '../utils.js';
import * as transaksiModel from '../models/transaksi.js';
import * as rekeningModel from '../models/rekening.js';
import { uploadAttachment } from '../sync/gdrive.js';
import { setVoiceCallback, consumePendingVoiceData } from '../voice.js';

export const title = 'Catat Transaksi';

const SHARE_CACHE_NAME = 'shared-files';
const SHARE_CACHE_KEY = './pwa-share-handle';

let abortController = null;
let flatpickrInstance = null;
let slimSelectInstances = [];
let objectUrls = [];
let mediaCleanup = null;

function parseAttachmentList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((x) => x && x !== 'uploading').map(String);
  const str = String(raw).trim();
  if (!str || str === 'uploading') return [];
  if (str.startsWith('[')) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) {
        return parsed.filter((x) => x && x !== 'uploading').map(String);
      }
    } catch {
      // Fallback to treating as single filename string
    }
  }
  return [str];
}

function sanitizeFilename(name) {
  const cleaned = String(name || 'file')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned || 'file';
}

function generateAttachmentFilename(originalName) {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  return `${ts}_${rand}_${sanitizeFilename(originalName)}`;
}

function destroySlimSelects() {
  for (const ss of slimSelectInstances) {
    try {
      ss.destroy();
    } catch {
      // Ignore SlimSelect destroy errors
    }
  }
  slimSelectInstances = [];
}

function cleanupResources() {
  setVoiceCallback(null);

  if (mediaCleanup) {
    try {
      mediaCleanup();
    } catch {
      // Ignore cleanup errors
    }
    mediaCleanup = null;
  }

  if (abortController) {
    abortController.abort();
    abortController = null;
  }

  destroySlimSelects();

  if (flatpickrInstance) {
    try {
      flatpickrInstance.destroy();
    } catch {
      // Ignore destroy errors
    }
    flatpickrInstance = null;
  }

  for (const url of objectUrls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Ignore revoke errors
    }
  }
  objectUrls = [];
}

async function readSharedFileFromCache() {
  if (typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(SHARE_CACHE_NAME);
    const response = await cache.match(SHARE_CACHE_KEY);
    if (!response) return null;

    const blob = await response.blob();
    const filename = response.headers.get('File-name') || 'shared-file';
    const contentType = response.headers.get('Content-Type') || blob.type || 'application/octet-stream';
    const file = new File([blob], filename, { type: contentType });

    await cache.delete(SHARE_CACHE_KEY);
    return file;
  } catch (err) {
    console.warn('Gagal membaca file dari Share Target cache:', err);
    return null;
  }
}

function rekeningSelectFormater(d) {
  const hartaIcon = d.harta ? '<small class="text-warning fas fa-coins"></small>' : '';
  const saldoHtml = d.isAsing
    ? `${escapeHtml(Number(d.saldo_asing ?? 0).toLocaleString('id-ID'))},- ${escapeHtml(d.nominal_asing || '')}`
    : `Rp. ${escapeHtml(Number(d.saldo ?? 0).toLocaleString('id-ID'))},-`;
  return {
    text: String(d.nama || ''),
    value: String(d.id),
    html: `<span class="d-flex justify-content-between w-100 me-2"><b>${hartaIcon}&nbsp;${escapeHtml(String(d.nama || '').toUpperCase())}</b><span>${saldoHtml}</span></span>`
  };
}

function debouncePromise(fn, delay = 400) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    return new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        Promise.resolve(fn(...args)).then(resolve).catch(reject);
      }, delay);
    });
  };
}

export async function mount(container, params = new URLSearchParams()) {
  cleanupResources();
  abortController = new AbortController();
  const { signal } = abortController;

  const editIdRaw = params?.get('id');
  const editId = editIdRaw ? String(editIdRaw).trim() : null;

  const [accounts, kelompokRows, existingTx, sharedFile] = await Promise.all([
    rekeningModel.getAll(),
    transaksiModel.getKelompok(),
    editId ? transaksiModel.getById(editId) : Promise.resolve(null),
    readSharedFileFromCache()
  ]);

  if (signal.aborted) return;

  if (editId && !existingTx) {
    showAlert(`Transaksi #${editId} tidak ditemukan.`, 'warning');
  }

  let initialRelatedTx = null;
  if (existingTx?.relasi_transaksi) {
    initialRelatedTx = await transaksiModel.getById(existingTx.relasi_transaksi);
    if (signal.aborted) return;
  }

  const isEdit = Boolean(existingTx);
  const activeAccounts = accounts.filter((a) => a.aktif || (existingTx && (String(a.id) === String(existingTx.rekening_sumber) || String(a.id) === String(existingTx.rekening_masuk))));
  const hartaAccounts = activeAccounts.filter((a) => a.harta);
  const accountMap = new Map(accounts.map((a) => [String(a.id), a]));
  const kelompokNames = [...new Set(kelompokRows.map((k) => k.kelompok).filter(Boolean))];

  const defaultJenis = existingTx?.jenis_transaksi && JENIS_TRANSAKSI.includes(existingTx.jenis_transaksi)
    ? existingTx.jenis_transaksi
    : (params?.get('jenis_transaksi') && JENIS_TRANSAKSI.includes(params.get('jenis_transaksi'))
      ? params.get('jenis_transaksi')
      : JENIS_TRANSAKSI[0]);

  const defaultTanggal = existingTx?.tanggal || formatDBDate(new Date());
  const defaultNominal = existingTx?.nominal !== undefined && existingTx?.nominal !== null
    ? formatID(String(existingTx.nominal).replace('.', ','))
    : '';
  const defaultNominalAsing = existingTx?.nominal_asing !== undefined && existingTx?.nominal_asing !== null && Number(existingTx.nominal_asing) !== 0
    ? formatID(String(existingTx.nominal_asing).replace('.', ','))
    : '';
  const defaultKuantitas = existingTx?.kuantitas ?? 1;
  const defaultPenyusutan = existingTx?.penyusutan_bunga !== undefined && existingTx?.penyusutan_bunga !== null
    ? formatID(String(existingTx.penyusutan_bunga).replace('.', ','))
    : '';

  const existingAttachments = parseAttachmentList(existingTx?.attachment);
  let pendingFiles = [];
  if (sharedFile) {
    pendingFiles = [sharedFile];
  }

  container.innerHTML = `
    <div class="container py-2">
      ${isEdit ? `
        <div class="d-flex justify-content-between align-items-center mb-2">
          <span class="badge text-bg-primary-subtle text-primary border border-primary-subtle px-3 py-2">
            <i class="fas fa-pen-to-square me-1"></i>Edit Transaksi #${escapeHtml(String(existingTx.id).padStart(4, '0'))}
          </span>
          <a href="#/transactions" class="btn btn-sm btn-outline-secondary rounded-pill">
            <i class="fas fa-arrow-left me-1"></i>Kembali
          </a>
        </div>
      ` : ''}
      <form id="form" method="post" class="row" enctype="multipart/form-data" novalidate>
        <div class="col-lg-8" id="main-group">
          <div class="form-group center-input">
            <label>Jenis Transaksi</label>
            <select class="form-control" id="jenis_transaksi" placeholder="Jenis Transaksi" name="jenis_transaksi" required>
              <option value="" class="hide" data-placeholder="true" readonly="true">Jenis Transaksi</option>
              ${JENIS_TRANSAKSI.map((x) => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Barang / Judul</label>
            <input type="text" class="form-control" placeholder="Barang / Judul" name="barang" required value="${escapeHtml(existingTx?.barang || params?.get('barang') || '')}">
          </div>
          <div class="p-3 mb-4 border-bottom border-top border-2 border-primary form-check form-switch d-flex justify-content-between ps-0" style="font-size: .75em;font-weight: 600;">
            <label class="form-check-label text-primary w-100" for="harta">Nilai Harta</label>
            <input class="form-check-input hide-group" type="checkbox" id="harta" name="harta" ${existingTx?.harta ? 'checked' : ''} disabled="true">
          </div>
          <div class="form-group center-input">
            <label>Rekening Sumber</label>
            <select class="form-control hide-group" id="rekening_sumber" placeholder="Rekening Sumber" name="rekening_sumber" required disabled="true">
              <option class="hide" value="" data-placeholder="true" readonly="true">Rekening Sumber</option>
            </select>
            <div class="d-flex justify-content-between font-weight-bold">
              <span class="info" id="rekening_sumber_akhir"></span>
            </div>
          </div>
          <div class="form-group center-input">
            <label>Rekening Masuk</label>
            <select class="form-control hide-group" id="rekening_masuk" placeholder="Rekening Masuk" name="rekening_masuk" required disabled="true">
              <option class="hide" value="" data-placeholder="true" readonly="true">Rekening Masuk</option>
            </select>
            <div class="d-flex justify-content-between font-weight-bold">
              <span class="info" id="rekening_masuk_akhir"></span>
            </div>
          </div>
          <div class="form-group">
            <label>Nominal</label>
            <div class="input-group">
              <span class="input-group-text">Rp.</span>
              <input type="text" class="form-control input-text-lg" placeholder="Nominal" name="nominal" inputmode="numeric" id="nominal" required value="${escapeHtml(defaultNominal)}">
            </div>
          </div>
          <div class="form-group">
            <label>Nominal Asing</label>
            <div class="input-group">
              <input type="text" class="form-control input-text-lg hide-group" placeholder="Nominal Asing" name="nominal_asing" inputmode="numeric" id="nominal_asing" disabled="true" value="${escapeHtml(defaultNominalAsing)}">
              <span class="input-group-text" id="nominalasing">Rp.</span>
            </div>
          </div>
          <div class="form-group">
            <label>Penyusutan / Bunga</label>
            <div class="input-group">
              <span class="input-group-text">Rp.</span>
              <input type="text" class="form-control input-text-lg hide-group" placeholder="Penyusutan / Bunga" name="penyusutan_bunga" inputmode="numeric" id="penyusutan_bunga" disabled="true" value="${escapeHtml(defaultPenyusutan)}">
            </div>
          </div>
          <div class="form-group">
            <label>Kuantitas</label>
            <input type="number" step="any" class="form-control input-text-lg" placeholder="Kuantitas" name="kuantitas" inputmode="numeric" id="kuantitas" min="0.0001" value="${escapeHtml(defaultKuantitas)}" required>
          </div>
          <div class="form-group">
            <label>Total Transaksi</label>
            <div class="input-group">
              <span class="input-group-text">Rp.</span>
              <input type="text" class="form-control input-text-lg" name="total" placeholder="Total Transaksi" inputmode="numeric" id="total" readonly>
            </div>
          </div>
          <div class="form-group">
            <label>Total Transaksi Asing</label>
            <div class="input-group">
              <input type="text" class="form-control input-text-lg hide-group" name="total_asing" placeholder="Total Transaksi" inputmode="numeric" id="total_asing" readonly disabled="true">
              <span class="input-group-text" id="totalasing">Rp.</span>
            </div>
          </div>
          <div class="p-3 mb-4 border-bottom border-top border-2 border-primary form-check form-switch d-flex justify-content-between ps-0" style="font-size: .75em;font-weight: 600;">
            <label class="form-check-label text-primary w-100" for="rutin">Rutin / Non Rutin</label>
            <input class="form-check-input" type="checkbox" id="rutin" name="rutin" ${existingTx?.rutin ? 'checked' : ''}>
          </div>
          <div class="form-group">
            <label>Kelompok Transaksi</label>
            <select class="form-control" id="kelompok" placeholder="Kelompok Transaksi" name="kelompok">
              <option class="hide" value="" data-placeholder="true" readonly="true">Kelompok Transaksi</option>
              ${kelompokNames.map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('')}
            </select>
          </div>
          ${!isEdit ? `
            <div id="pair-harta-box" class="border border-primary-subtle rounded-3 p-3 mb-3 d-none">
              <div class="form-check form-switch d-flex justify-content-between align-items-center ps-0 mb-0" style="font-size: .82em; font-weight: 600;">
                <label class="form-check-label text-primary w-100" for="pair_harta">
                  <i class="fas fa-coins me-1"></i>Catat juga sebagai Aset Harta
                </label>
                <input class="form-check-input" type="checkbox" id="pair_harta">
              </div>
              <div id="pair-harta-fields" class="mt-2 pt-2 border-top d-none">
                <div class="mb-2">
                  <label class="small text-secondary mb-1" for="pair_harta_rekening">Rekening Aset Harta</label>
                  <select id="pair_harta_rekening" class="form-select form-select-sm">
                    ${hartaAccounts.map((a, idx) => `<option value="${escapeHtml(a.id)}"${idx === 0 ? ' selected' : ''}>${escapeHtml(a.nama)}</option>`).join('')}
                  </select>
                </div>
                <div>
                  <label class="small text-secondary mb-1" for="pair_harta_months">Masa Penyusutan (bulan, 0 = tanpa penyusutan)</label>
                  <div class="d-flex align-items-center gap-2">
                    <input type="number" id="pair_harta_months" class="form-control form-control-sm" min="0" value="48" style="max-width: 110px;">
                    <small id="pair_harta_preview" class="text-muted"></small>
                  </div>
                </div>
              </div>
            </div>
            <div id="pair-hutang-box" class="border border-primary-subtle rounded-3 p-3 mb-3 d-none">
              <div class="small text-secondary mb-2">
                <i class="fas fa-info-circle text-primary me-1"></i>Bayar tagihan CC / pokok cicilan pakai Pindah Buku agar tidak double-counting.
              </div>
              <label class="small text-secondary mb-1" for="pair_hutang_bunga">+ Bunga / Biaya Admin (opsional)</label>
              <div class="input-group input-group-sm">
                <span class="input-group-text">Rp.</span>
                <input type="text" id="pair_hutang_bunga" class="form-control" placeholder="0" inputmode="numeric">
              </div>
            </div>
          ` : ''}
        </div>
        <div class="col-lg-4" id="summary-group">
          <div class="form-group">
            <label>Tanggal Transaksi</label>
            <input type="date" id="tanggal" placeholder="Tanggal Transaksi" name="tanggal" class="form-control input-text-lg date-format" required value="${escapeHtml(defaultTanggal)}">
          </div>
          <div class="form-group">
            <label>Koneksikan Transaksi</label>
            <select class="form-control" id="relasi_transaksi" placeholder="Koneksikan Transaksi" name="relasi_transaksi">
              <option class="hide" value="" data-placeholder="true" readonly="true">Koneksikan Transaksi</option>
              ${initialRelatedTx ? `<option value="${escapeHtml(initialRelatedTx.id)}" selected>${escapeHtml(initialRelatedTx.barang)}-${escapeHtml(initialRelatedTx.id)}</option>` : ''}
            </select>
          </div>
          <div class="form-group">
            <input type="file" placeholder="Attachment" class="form-control" accept="image/*, application/pdf" name="attachment[]" id="attachment" multiple />
            <div id="existing-attachment-list" class="d-flex flex-wrap gap-2 mt-2"></div>
            <div id="record-attachment-info" class="small text-secondary mt-1" style="display:none;"></div>
            <canvas id="preview-canvas" style="display:none; max-width: 100%;" class="mt-2 rounded border"></canvas>
          </div>
          <div class="form-group">
            <div>
              <textarea name="keterangan" class="form-control border-bottom border-primary mb-2" placeholder="Keterangan" rows="5">${escapeHtml(existingTx?.keterangan || '')}</textarea>
              <input type="submit" class="btn w-100" value="${isEdit ? 'Perbarui Transaksi' : 'Catat Transaksi'}" name="record">
            </div>
          </div>
        </div>
        <div id="ss-dropdown"></div>
      </form>
    </div>
  `;

  const FORM = container.querySelector('form#form');
  const ssDropdown = container.querySelector('#ss-dropdown');
  const rekening_sumber_akhir = container.querySelector('#rekening_sumber_akhir');
  const rekening_masuk_akhir = container.querySelector('#rekening_masuk_akhir');
  const existingAttachmentEl = container.querySelector('#existing-attachment-list');
  const infoEl = container.querySelector('#record-attachment-info');
  const canvas = container.querySelector('#preview-canvas');
  const ctx = canvas?.getContext('2d');
  const pairHartaBox = container.querySelector('#pair-harta-box');
  const pairHartaCheckbox = container.querySelector('#pair_harta');
  const pairHartaFields = container.querySelector('#pair-harta-fields');
  const pairHartaRekEl = container.querySelector('#pair_harta_rekening');
  const pairHartaMonthsEl = container.querySelector('#pair_harta_months');
  const pairHartaPreviewEl = container.querySelector('#pair_harta_preview');
  const pairHutangBox = container.querySelector('#pair-hutang-box');
  const pairHutangBungaEl = container.querySelector('#pair_hutang_bunga');

  function updatePairedControls() {
    if (pairHartaBox) {
      const showHartaPair =
        !isEdit &&
        FORM.jenis_transaksi.value === 'Pengeluaran' &&
        !FORM.harta.checked &&
        hartaAccounts.length > 0;
      pairHartaBox.classList.toggle('d-none', !showHartaPair);
      if (!showHartaPair) {
        if (pairHartaCheckbox) pairHartaCheckbox.checked = false;
        pairHartaFields?.classList.add('d-none');
      } else {
        const checked = Boolean(pairHartaCheckbox?.checked);
        pairHartaFields?.classList.toggle('d-none', !checked);
        if (checked && pairHartaPreviewEl) {
          const nominalVal = parseIDNumber(FORM.nominal.value);
          const months = Number.parseInt(pairHartaMonthsEl?.value || '0', 10);
          if (months > 0 && Number.isFinite(nominalVal) && nominalVal > 0) {
            pairHartaPreviewEl.textContent = `Rp ${Math.round(nominalVal / months).toLocaleString('id-ID')}/bln`;
          } else {
            pairHartaPreviewEl.textContent = 'Tanpa penyusutan';
          }
        }
      }
    }

    if (pairHutangBox) {
      const showHutangPair =
        !isEdit &&
        FORM.jenis_transaksi.value === 'Pindah Buku' &&
        Boolean(FORM.rekening_masuk.rekening?.hutang);
      pairHutangBox.classList.toggle('d-none', !showHutangPair);
      if (!showHutangPair && pairHutangBungaEl) {
        pairHutangBungaEl.value = '';
      }
    }
  }

  // Helper to toggle field visibility & disabled state
  FORM.switchStateInput = (element, state = null) => {
    if (typeof element === 'string') element = container.querySelector(element);
    if (!(element instanceof Element) || !FORM.contains(element)) return;
    if (state === null) state = element.disabled;
    if (state === !element.disabled) return;
    element.disabled = !state;
    element.classList.toggle('hide-group', !state);
    if (!state) {
      if (element.type === 'checkbox') {
        element.checked = false;
      } else {
        element.value = '';
      }
      if (element.SlimSelect) {
        setTimeout(() => element.SlimSelect?.setSelected(''), 0);
      }
    }
  };

  if (window.flatpickr && FORM.tanggal) {
    FORM.tanggal.type = 'text';
    FORM.tanggal.readOnly = true;
    flatpickrInstance = window.flatpickr(FORM.tanggal, {
      disableMobile: true,
      dateFormat: 'Y-m-d',
      altInput: true,
      altFormat: 'd M Y',
      altInputClass: 'form-control input-text-lg date-format',
      defaultDate: defaultTanggal
    });
  }

  // Initialize SlimSelect widgets (with safe fallback if CDN blocked)
  const setSelectValue = (selectEl, val) => {
    const strVal = val !== null && val !== undefined ? String(val) : '';
    if (selectEl.SlimSelect) {
      selectEl.SlimSelect.setSelected(strVal);
    } else {
      selectEl.value = strVal;
    }
  };

  try {
    await ensureSlimSelect();
  } catch {
    // Fallback to native select if CDN blocked
  }
  if (signal.aborted) return;

  const buildRekeningData = (list, placeholderText) => [
    { placeholder: true, text: placeholderText, value: '' },
    ...list.map(rekeningSelectFormater)
  ];

  if (window.SlimSelect) {
    FORM.jenis_transaksi.SlimSelect = new window.SlimSelect({
      select: FORM.jenis_transaksi,
      settings: {
        contentLocation: ssDropdown,
        allowDeselect: false
      }
    });
    FORM.rekening_sumber.SlimSelect = new window.SlimSelect({
      select: FORM.rekening_sumber,
      data: buildRekeningData(activeAccounts, 'Rekening Sumber'),
      settings: {
        contentLocation: ssDropdown,
        placeholderText: 'Rekening Sumber',
        allowDeselect: true
      }
    });
    FORM.rekening_masuk.SlimSelect = new window.SlimSelect({
      select: FORM.rekening_masuk,
      data: buildRekeningData(activeAccounts, 'Rekening Masuk'),
      settings: {
        contentLocation: ssDropdown,
        placeholderText: 'Rekening Masuk',
        allowDeselect: true
      }
    });
    FORM.rekening_sumber.SlimSelect.setSelected('');
    FORM.rekening_masuk.SlimSelect.setSelected('');
    FORM.kelompok.SlimSelect = new window.SlimSelect({
      select: FORM.kelompok,
      settings: {
        contentLocation: ssDropdown,
        placeholderText: 'Kelompok Transaksi',
        allowDeselect: true
      },
      events: {
        addable: (value) => value
      }
    });
    FORM.kelompok.SlimSelect.setSelected('');
    FORM.relasi_transaksi.SlimSelect = new window.SlimSelect({
      select: FORM.relasi_transaksi,
      settings: {
        contentLocation: ssDropdown,
        placeholderText: 'Koneksikan Transaksi',
        allowDeselect: true
      },
      events: {
        search: debouncePromise(async (search) => {
          const q = search.trim();
          if (q.length < 2) return Promise.reject('Setidaknya 2 huruf');
          const rows = await transaksiModel.filter({ search: q, limit: 20 });
          return rows
            .filter((d) => !editId || String(d.id) !== String(editId))
            .map((d) => ({
              text: `${d.barang}-${d.id}`,
              value: String(d.id),
              html: `
                <div class="w-100 d-flex justify-content-between flex-row">
                  <b class="truncate-text">${escapeHtml(d.barang || '')}</b>
                  <span class="truncate-text">${d.nama_rekening_sumber ? `-${escapeHtml(d.nama_rekening_sumber)}` : ''}${d.nama_rekening_masuk ? `+${escapeHtml(d.nama_rekening_masuk)}` : ''}</span>
                  <small style="font-size:.75em">[${escapeHtml(d.id)}]</small>
                </div>
                <div class="w-100 d-flex justify-content-between">
                  <b>Rp.${escapeHtml(Number(d.nominal || 0).toLocaleString('id-ID'))}</b>
                  <span class="truncate-text">${escapeHtml(d.kelompok || '')}</span>
                </div>
              `
            }));
        }, 350)
      }
    });

    slimSelectInstances.push(
      FORM.jenis_transaksi.SlimSelect,
      FORM.rekening_sumber.SlimSelect,
      FORM.rekening_masuk.SlimSelect,
      FORM.kelompok.SlimSelect,
      FORM.relasi_transaksi.SlimSelect
    );
  } else {
    const htmlOptions = activeAccounts
      .map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.nama)}</option>`)
      .join('');
    FORM.rekening_sumber.insertAdjacentHTML('beforeend', htmlOptions);
    FORM.rekening_masuk.insertAdjacentHTML('beforeend', htmlOptions);
  }

  FORM.rekening_sumber.lawan = FORM.rekening_masuk;
  FORM.rekening_masuk.lawan = FORM.rekening_sumber;

  function validateRekeningSelection(e) {
    const masukVal = FORM.rekening_masuk.value;
    const sumberVal = FORM.rekening_sumber.value;
    const masukRek = FORM.rekening_masuk.rekening;
    const sumberRek = FORM.rekening_sumber.rekening;

    const resetSelect = () => {
      e.target.rekening = null;
      if (e.target.SlimSelect) {
        setTimeout(() => e.target.SlimSelect?.setSelected(''), 0);
      } else {
        e.target.value = '';
      }
    };

    if (masukVal && sumberVal && masukVal === sumberVal) {
      showAlert('Tidak bisa pindah buku sama rekening', 'warning');
      resetSelect();
      return false;
    }
    if (masukRek?.harta || sumberRek?.harta) {
      showAlert('Rekening Aset Harta tidak boleh langsung pindah buku', 'warning');
      resetSelect();
      return false;
    }
    if (masukRek?.isAsing && sumberRek?.isAsing && masukRek.nominal_asing !== sumberRek.nominal_asing) {
      showAlert('Tidak bisa pindah buku antar rekening dengan jenis uang asing berbeda', 'warning');
      resetSelect();
      return false;
    }
    return true;
  }

  function hitung() {
    const {
      nominal,
      nominal_asing,
      kuantitas,
      total,
      total_asing,
      rekening_sumber,
      rekening_masuk
    } = FORM;

    const qty = Math.max(1, Number.parseFloat(kuantitas.value) || 1);
    const nominalIDR = nominal.value ? parseIDNumber(nominal.value) : null;
    const nominalAsing = nominal_asing.value ? parseIDNumber(nominal_asing.value) : null;

    const sumber = rekening_sumber.rekening;
    const masuk = rekening_masuk.rekening;

    const formatSaldo = (val) => Number(val || 0).toLocaleString('id-ID');
    const formatDisplaySaldo = (val) => (Number.isInteger(val) ? `${formatSaldo(val)},-` : formatSaldo(val));

    const totalIDR = nominalIDR !== null ? nominalIDR * qty : 0;
    const totalAsing = nominalAsing !== null ? nominalAsing * qty : 0;
    const saldoAkhirMasuk = Number(masuk?.saldo || 0) + totalIDR;
    const saldoAkhirSumber = Number(sumber?.saldo || 0) - totalIDR;
    const saldoAkhirMasukAsing = Number(masuk?.saldo_asing || 0) + totalAsing;
    const saldoAkhirSumberAsing = Number(sumber?.saldo_asing || 0) - totalAsing;

    total.value = totalIDR > 0 ? formatSaldo(totalIDR) : '';
    total_asing.value = totalAsing > 0 ? formatSaldo(totalAsing) : '';
    rekening_sumber_akhir.innerHTML = '';
    rekening_masuk_akhir.innerHTML = '';

    if (nominalIDR !== null && nominal.value.trim() !== '' && qty) {
      if (sumber) {
        rekening_sumber_akhir.innerHTML = `
          <p class="d-flex justify-content-between mb-0 w-100">Saldo Akhir : <b>Rp.${escapeHtml(formatDisplaySaldo(saldoAkhirSumber))}</b></p>
        `;
      }
      if (masuk) {
        rekening_masuk_akhir.innerHTML = `
          <p class="d-flex justify-content-between mb-0 w-100">Saldo Akhir : <b>Rp.${escapeHtml(formatDisplaySaldo(saldoAkhirMasuk))}</b></p>
        `;
      }
    }

    if (nominalAsing !== null && nominal_asing.value.trim() !== '' && qty) {
      if (sumber && sumber.isAsing) {
        rekening_sumber_akhir.innerHTML = `
          <p class="d-flex justify-content-between mb-0 w-100">Saldo Akhir : <b>${escapeHtml(formatDisplaySaldo(saldoAkhirSumberAsing))}&nbsp;${escapeHtml(sumber.nominal_asing)}</b></p>
          <small class="d-flex justify-content-end w-100">Rp.&nbsp;${escapeHtml(formatDisplaySaldo(saldoAkhirSumber))}</small>
        `;
      }
      if (masuk && masuk.isAsing) {
        rekening_masuk_akhir.innerHTML = `
          <p class="d-flex justify-content-between mb-0 w-100">Saldo Akhir : <b>${escapeHtml(formatDisplaySaldo(saldoAkhirMasukAsing))}&nbsp;${escapeHtml(masuk.nominal_asing)}</b></p>
          <small class="d-flex justify-content-end w-100">Rp.&nbsp;${escapeHtml(formatDisplaySaldo(saldoAkhirMasuk))}</small>
        `;
      }
    }
  }

  function updateAsingVisibility() {
    const sumber = FORM.rekening_sumber.rekening;
    const masuk = FORM.rekening_masuk.rekening;
    const asingRek = sumber?.isAsing ? sumber : (masuk?.isAsing ? masuk : null);
    const isAsing = Boolean(asingRek);

    FORM.switchStateInput(FORM.nominal_asing, isAsing);
    FORM.switchStateInput(FORM.total_asing, isAsing);

    if (asingRek) {
      const code = asingRek.nominal_asing || 'Asing';
      container.querySelector('#nominalasing').textContent = code;
      container.querySelector('#totalasing').textContent = code;
    } else {
      container.querySelector('#nominalasing').textContent = 'Rp.';
      container.querySelector('#totalasing').textContent = 'Rp.';
    }
  }

  function rekeningSelectEvent(e) {
    if (e.target.disabled) return;
    e.target.rekening = accountMap.get(String(e.target.value)) || null;
    hitung();

    const isPindahBuku = JENIS_TRANSAKSI[2] === FORM.jenis_transaksi.value;
    if (isPindahBuku && !validateRekeningSelection(e)) {
      hitung();
      updateAsingVisibility();
      return;
    }

    updateAsingVisibility();
  }

  FORM.harta.State = FORM.harta.checked;
  FORM.harta.switchState = (state = !FORM.harta.State, preserveSelection = false) => {
    if (state === FORM.harta.State) return;
    FORM.relasi_transaksi.required = state;
    FORM.switchStateInput(FORM.penyusutan_bunga, state);

    const list = state ? activeAccounts.filter((r) => r.harta) : activeAccounts;
    const prevSumber = preserveSelection ? FORM.rekening_sumber.value : '';
    const prevMasuk = preserveSelection ? FORM.rekening_masuk.value : '';

    if (FORM.rekening_sumber.SlimSelect && FORM.rekening_masuk.SlimSelect) {
      FORM.rekening_sumber.SlimSelect.setData(buildRekeningData(list, 'Rekening Sumber'));
      FORM.rekening_masuk.SlimSelect.setData(buildRekeningData(list, 'Rekening Masuk'));
      setSelectValue(FORM.rekening_sumber, list.some((a) => String(a.id) === String(prevSumber)) ? prevSumber : '');
      setSelectValue(FORM.rekening_masuk, list.some((a) => String(a.id) === String(prevMasuk)) ? prevMasuk : '');
    }

    FORM.rekening_sumber.rekening = accountMap.get(String(FORM.rekening_sumber.value)) || null;
    FORM.rekening_masuk.rekening = accountMap.get(String(FORM.rekening_masuk.value)) || null;
    FORM.harta.State = state;
    updateAsingVisibility();
    hitung();
    updatePairedControls();
  };

  FORM.rutin.State = FORM.rutin.checked;
  FORM.rutin.switchState = (state = !FORM.rutin.State) => {
    if (state === FORM.rutin.State) return;
    FORM.kelompok.required = state;
    FORM.rutin.State = state;
  };

  function formState(e) {
    const jenis_transaksi = e?.target?.value ?? FORM.jenis_transaksi.value ?? defaultJenis;
    const state = JENIS_TRANSAKSI.map((v) => v === jenis_transaksi);

    FORM.switchStateInput(FORM.harta, state[0] || state[1]);
    FORM.harta.switchState((state[0] || state[1]) && FORM.harta.checked, true);
    FORM.rutin.switchState((state[0] || state[1]) && FORM.rutin.checked);

    if (!(state[0] || state[2])) {
      FORM.rekening_sumber.rekening = null;
      setSelectValue(FORM.rekening_sumber, '');
    }
    FORM.switchStateInput(FORM.rekening_sumber, state[0] || state[2]);

    if (!(state[1] || state[2])) {
      FORM.rekening_masuk.rekening = null;
      setSelectValue(FORM.rekening_masuk, '');
    }
    FORM.switchStateInput(FORM.rekening_masuk, state[1] || state[2]);

    updateAsingVisibility();
    hitung();
    updatePairedControls();
  }

  // Responsive layout switching
  const formBreakpoint = window.matchMedia('(min-width: 768px)');
  const moveSummary = () => {
    if (!FORM.isConnected) return;
    if (formBreakpoint.matches) {
      FORM.tanggal.closest('.form-group').insertAdjacentElement('afterend', FORM.total_asing.closest('.form-group'));
      FORM.tanggal.closest('.form-group').insertAdjacentElement('afterend', FORM.total.closest('.form-group'));
      FORM.tanggal.closest('.form-group').insertAdjacentElement('afterend', FORM.rekening_masuk.closest('.form-group'));
      FORM.tanggal.closest('.form-group').insertAdjacentElement('afterend', FORM.rekening_sumber.closest('.form-group'));
      FORM.tanggal.closest('.form-group').insertAdjacentElement('afterend', FORM.harta.closest('div'));
    } else {
      FORM.barang.closest('.form-group').insertAdjacentElement('afterend', FORM.harta.closest('div'));
      FORM.harta.closest('div').insertAdjacentElement('afterend', FORM.rekening_sumber.closest('.form-group'));
      FORM.rekening_sumber.closest('.form-group').insertAdjacentElement('afterend', FORM.rekening_masuk.closest('.form-group'));
      FORM.kuantitas.closest('.form-group').insertAdjacentElement('afterend', FORM.total.closest('.form-group'));
      FORM.total.closest('.form-group').insertAdjacentElement('afterend', FORM.total_asing.closest('.form-group'));
    }
  };
  formBreakpoint.addEventListener('change', moveSummary);
  mediaCleanup = () => formBreakpoint.removeEventListener('change', moveSummary);
  moveSummary();

  // Existing attachments (Edit mode)
  function renderExistingAttachments() {
    if (!existingAttachmentEl) return;
    if (existingAttachments.length === 0) {
      existingAttachmentEl.innerHTML = '';
      return;
    }
    existingAttachmentEl.innerHTML = existingAttachments.map((filename, idx) => `
      <span class="badge text-bg-light border text-dark d-inline-flex align-items-center gap-2 py-2 px-2">
        <i class="fas fa-paperclip text-secondary"></i>
        <span class="text-truncate" style="max-width: 170px;">${escapeHtml(filename)}</span>
        <button type="button" class="btn-close" style="font-size: 0.65rem;" data-remove-existing="${idx}" aria-label="Hapus lampiran"></button>
      </span>
    `).join('');
  }
  existingAttachmentEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-existing]');
    if (!btn) return;
    const idx = Number.parseInt(btn.getAttribute('data-remove-existing'), 10);
    if (!Number.isNaN(idx)) {
      existingAttachments.splice(idx, 1);
      renderExistingAttachments();
    }
  }, { signal });
  renderExistingAttachments();

  // Preview & attachment intake (file input, paste, Share Target)
  async function previewFiles(files) {
    pendingFiles = files;
    if (!infoEl || !canvas || !ctx) return;

    if (!files.length) {
      infoEl.style.display = 'none';
      canvas.style.display = 'none';
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    infoEl.innerHTML = `<i class="fas fa-paperclip"></i> <b>${files.length}</b> file dipilih`;
    infoEl.style.display = 'block';

    const file = files[0];
    canvas.style.display = 'none';
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (file.type === 'application/pdf') {
      try {
        const pdfjsLib = await ensurePdfJs();
        if (!pdfjsLib || signal.aborted) return;
        const buffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 1.5 });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.display = 'block';
        await page.render({ canvasContext: ctx, viewport }).promise;
      } catch (err) {
        console.warn('PDF preview error:', err);
      }
    } else if (file.type.startsWith('image/')) {
      const img = new Image();
      const url = URL.createObjectURL(file);
      objectUrls.push(url);
      img.onload = () => {
        const maxWidth = 600;
        const scale = Math.min(maxWidth / img.width, 1);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        canvas.style.display = 'block';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      };
      img.src = url;
    } else {
      showAlert(`Tipe file tidak didukung: ${file.type || file.name}`, 'warning');
    }
  }

  function handleFileUpload(event) {
    const rawFiles = [...(event.target?.files || event.clipboardData?.files || [])];
    if (rawFiles.length === 0) return;

    if (typeof DataTransfer !== 'undefined' && FORM.attachment) {
      try {
        const dt = new DataTransfer();
        rawFiles.forEach((f) => dt.items.add(f));
        FORM.attachment.files = dt.files;
      } catch {
        // Ignore if DataTransfer assignment is restricted
      }
    }
    previewFiles(rawFiles);
  }

  FORM.attachment?.addEventListener('change', handleFileUpload, { signal });
  document.addEventListener('paste', handleFileUpload, { signal });

  if (sharedFile) {
    previewFiles([sharedFile]);
    showAlert(`Lampiran "${sharedFile.name}" dari Share Target siap diunggah.`, 'info');
  }

  // Wire field events
  FORM.jenis_transaksi.addEventListener('change', formState, { signal });
  FORM.rekening_sumber.addEventListener('change', rekeningSelectEvent, { signal });
  FORM.rekening_masuk.addEventListener('change', rekeningSelectEvent, { signal });
  FORM.harta.addEventListener('change', (e) => e.target.switchState(e.target.checked, true), { signal });
  FORM.rutin.addEventListener('change', (e) => e.target.switchState(e.target.checked), { signal });
  FORM.kuantitas.addEventListener('input', hitung, { signal });
  FORM.kuantitas.addEventListener('keyup', hitung, { signal });

  [FORM.nominal, FORM.nominal_asing, FORM.penyusutan_bunga].forEach((el) => {
    el?.addEventListener('input', () => {
      const formatted = formatID(el.value);
      if (el.value !== formatted) el.value = formatted;
      hitung();
      updatePairedControls();
    }, { signal });
  });

  pairHartaCheckbox?.addEventListener('change', updatePairedControls, { signal });
  pairHartaMonthsEl?.addEventListener('input', updatePairedControls, { signal });
  pairHutangBungaEl?.addEventListener('input', () => {
    const formatted = formatID(pairHutangBungaEl.value);
    if (pairHutangBungaEl.value !== formatted) pairHutangBungaEl.value = formatted;
  }, { signal });

  // Apply initial state / Edit values / URL prefills
  setSelectValue(FORM.jenis_transaksi, defaultJenis);
  formState({ target: { value: defaultJenis } });

  const initSumber = existingTx?.rekening_sumber ?? params?.get('rekening_sumber');
  const initMasuk = existingTx?.rekening_masuk ?? params?.get('rekening_masuk');

  if (existingTx?.harta) {
    FORM.harta.checked = true;
    FORM.harta.switchState(true, true);
  }
  if (initSumber && accountMap.has(String(initSumber))) {
    setSelectValue(FORM.rekening_sumber, initSumber);
    FORM.rekening_sumber.rekening = accountMap.get(String(initSumber));
  }
  if (initMasuk && accountMap.has(String(initMasuk))) {
    setSelectValue(FORM.rekening_masuk, initMasuk);
    FORM.rekening_masuk.rekening = accountMap.get(String(initMasuk));
  }
  if (existingTx?.kelompok) {
    if (FORM.kelompok.SlimSelect) {
      const existingOpts = FORM.kelompok.SlimSelect.getData();
      if (!existingOpts.some((o) => o.value === existingTx.kelompok)) {
        FORM.kelompok.SlimSelect.setData([...existingOpts, { text: existingTx.kelompok, value: existingTx.kelompok }]);
      }
    }
    setSelectValue(FORM.kelompok, existingTx.kelompok);
  }
  if (existingTx?.rutin) {
    FORM.rutin.checked = true;
    FORM.rutin.switchState(true);
  }
  if (initialRelatedTx) {
    setSelectValue(FORM.relasi_transaksi, initialRelatedTx.id);
  }
  updateAsingVisibility();
  hitung();
  updatePairedControls();

  // Voice Input integration (FAB visible ONLY while #/record is mounted)
  async function applyVoiceParsed(parsed) {
    if (!parsed) return;

    if (parsed.jenis && JENIS_TRANSAKSI.includes(parsed.jenis)) {
      setSelectValue(FORM.jenis_transaksi, parsed.jenis);
      formState({ target: { value: parsed.jenis } });
    }
    if (parsed.barang) {
      FORM.barang.value = parsed.barang;
    }
    if (Number(parsed.nominal) > 0) {
      FORM.nominal.value = formatID(String(parsed.nominal).replace('.', ','));
    }

    if (parsed.jenis === JENIS_TRANSAKSI[2]) {
      if (parsed.rekSumber) {
        setSelectValue(FORM.rekening_sumber, parsed.rekSumber.id);
        FORM.rekening_sumber.rekening = accountMap.get(String(parsed.rekSumber.id)) || parsed.rekSumber;
      }
      if (parsed.rekMasuk) {
        setSelectValue(FORM.rekening_masuk, parsed.rekMasuk.id);
        FORM.rekening_masuk.rekening = accountMap.get(String(parsed.rekMasuk.id)) || parsed.rekMasuk;
      }
    } else if (parsed.jenis === JENIS_TRANSAKSI[1]) {
      if (parsed.rekMasuk) {
        setSelectValue(FORM.rekening_masuk, parsed.rekMasuk.id);
        FORM.rekening_masuk.rekening = accountMap.get(String(parsed.rekMasuk.id)) || parsed.rekMasuk;
      }
    } else if (parsed.rekSumber) {
      setSelectValue(FORM.rekening_sumber, parsed.rekSumber.id);
      FORM.rekening_sumber.rekening = accountMap.get(String(parsed.rekSumber.id)) || parsed.rekSumber;
    }

    if (parsed.isRutin) {
      FORM.rutin.checked = true;
      FORM.rutin.switchState(true);
    }

    if (parsed.kelompok) {
      const matched = kelompokNames.find(
        (k) => k.toLowerCase() === String(parsed.kelompok).trim().toLowerCase()
      );
      const kelVal = matched || String(parsed.kelompok).trim();
      if (FORM.kelompok.SlimSelect) {
        const existingData = FORM.kelompok.SlimSelect.getData();
        if (!existingData.some((opt) => opt.value === kelVal)) {
          FORM.kelompok.SlimSelect.setData([...existingData, { text: kelVal, value: kelVal }]);
        }
      }
      setSelectValue(FORM.kelompok, kelVal);
    }

    updateAsingVisibility();
    hitung();
    updatePairedControls();
  }

  setVoiceCallback(applyVoiceParsed);
  const pendingVoice = consumePendingVoiceData();
  if (pendingVoice) {
    await applyVoiceParsed(pendingVoice);
  }

  // Submit handler
  FORM.addEventListener('submit', async (e) => {
    e.preventDefault();

    const jenis_transaksi = FORM.jenis_transaksi.value;
    const barang = FORM.barang.value.trim();
    const kelompok = FORM.kelompok.value.trim() || null;
    const nominal = parseIDNumber(FORM.nominal.value);
    const kuantitasRaw = Number.parseFloat(FORM.kuantitas.value);
    const kuantitas = Number.isFinite(kuantitasRaw) && kuantitasRaw > 0 ? kuantitasRaw : 1;
    const tanggal = FORM.tanggal.value.trim() || formatDBDate(new Date());
    const harta = FORM.harta.checked;
    const rutin = FORM.rutin.checked;
    const penyusutan_bunga = harta ? parseIDNumber(FORM.penyusutan_bunga.value) : 0;
    const relasiRaw = String(FORM.relasi_transaksi.value || '').trim();
    const relasi_transaksi = relasiRaw ? Number.parseInt(relasiRaw, 10) : null;
    const keterangan = FORM.keterangan.value.trim() || null;

    const needsSumber = jenis_transaksi === 'Pengeluaran' || jenis_transaksi === 'Pindah Buku';
    const needsMasuk = jenis_transaksi === 'Pemasukan' || jenis_transaksi === 'Pindah Buku';
    const rekening_sumber = needsSumber && FORM.rekening_sumber.value
      ? Number.parseInt(FORM.rekening_sumber.value, 10)
      : null;
    const rekening_masuk = needsMasuk && FORM.rekening_masuk.value
      ? Number.parseInt(FORM.rekening_masuk.value, 10)
      : null;

    const nominal_asing = !FORM.nominal_asing.disabled ? parseIDNumber(FORM.nominal_asing.value) : 0;

    if (!barang) {
      showAlert('Barang / Judul wajib diisi.', 'warning');
      return;
    }
    if (needsSumber && !rekening_sumber) {
      showAlert('Pilih Rekening Sumber.', 'warning');
      return;
    }
    if (needsMasuk && !rekening_masuk) {
      showAlert('Pilih Rekening Masuk.', 'warning');
      return;
    }
    if (rutin && !kelompok) {
      showAlert('Kelompok transaksi wajib diisi untuk transaksi rutin.', 'warning');
      return;
    }
    if (harta && !relasi_transaksi) {
      showAlert('Koneksikan Transaksi (relasi) wajib diisi untuk Nilai Harta.', 'warning');
      return;
    }
    if (jenis_transaksi === 'Pindah Buku') {
      const sAcc = accountMap.get(String(rekening_sumber));
      const mAcc = accountMap.get(String(rekening_masuk));
      if (rekening_sumber === rekening_masuk) {
        showAlert('Tidak bisa pindah buku sama rekening.', 'warning');
        return;
      }
      if (sAcc?.harta || mAcc?.harta) {
        showAlert('Rekening Aset Harta tidak boleh langsung pindah buku.', 'warning');
        return;
      }
      if (sAcc?.isAsing && mAcc?.isAsing && sAcc.nominal_asing !== mAcc.nominal_asing) {
        showAlert('Tidak bisa pindah buku antar rekening dengan jenis uang asing berbeda.', 'warning');
        return;
      }
    }
    if (!Number.isFinite(nominal) || nominal <= 0) {
      showAlert('Nominal harus lebih besar dari 0.', 'warning');
      return;
    }

    const usePairHarta =
      !isEdit &&
      Boolean(pairHartaCheckbox?.checked) &&
      pairHartaBox &&
      !pairHartaBox.classList.contains('d-none');
    const pairHartaRekId = usePairHarta && pairHartaRekEl?.value
      ? Number.parseInt(pairHartaRekEl.value, 10)
      : null;
    if (usePairHarta && !pairHartaRekId) {
      showAlert('Pilih Rekening Aset Harta.', 'warning');
      return;
    }

    const usePairHutangBunga =
      !isEdit &&
      pairHutangBox &&
      !pairHutangBox.classList.contains('d-none') &&
      parseIDNumber(pairHutangBungaEl?.value || '') > 0;
    const bungaNominal = usePairHutangBunga ? parseIDNumber(pairHutangBungaEl.value) : 0;

    const submitBtn = FORM.record;
    submitBtn.disabled = true;
    submitBtn.value = 'Memproses...';

    try {
      const uploadedNames = [];
      for (const file of pendingFiles) {
        const targetName = generateAttachmentFilename(file.name);
        const savedName = await uploadAttachment(targetName, file);
        uploadedNames.push(savedName);
      }

      const allAttachments = [...existingAttachments, ...uploadedNames];
      const attachment = allAttachments.length === 0
        ? null
        : allAttachments.length === 1
          ? allAttachments[0]
          : JSON.stringify(allAttachments);

      const payload = {
        jenis_transaksi,
        harta,
        rutin,
        barang,
        kelompok,
        rekening_sumber,
        rekening_masuk,
        nominal,
        nominal_asing,
        kuantitas,
        penyusutan_bunga,
        tanggal,
        relasi_transaksi,
        attachment,
        keterangan,
        review: existingTx?.review ?? null
      };

      if (isEdit) {
        await transaksiModel.updateTransaksi(existingTx.id, payload);
        showAlert(`Transaksi #${String(existingTx.id).padStart(4, '0')} berhasil diperbarui.`, 'success');
      } else {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const created_at = `${formatDBDate(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

        if (usePairHarta) {
          const months = Number.parseInt(pairHartaMonthsEl?.value || '0', 10);
          const monthlyDepr = months > 0 ? Math.round(nominal / months) : 0;
          await transaksiModel.insertBatch([
            { ...payload, harta: false, penyusutan_bunga: 0, created_at },
            {
              jenis_transaksi: 'Pemasukan',
              harta: true,
              rutin: false,
              barang,
              kelompok,
              rekening_sumber: null,
              rekening_masuk: pairHartaRekId,
              nominal,
              nominal_asing,
              kuantitas,
              penyusutan_bunga: monthlyDepr,
              tanggal,
              relasi_transaksi: '#1',
              attachment: null,
              keterangan,
              review: null,
              created_at
            }
          ]);
          showAlert('Transaksi & Aset Harta berhasil disimpan.', 'success');
        } else if (usePairHutangBunga) {
          await transaksiModel.insertBatch([
            { ...payload, created_at },
            {
              jenis_transaksi: 'Pengeluaran',
              harta: false,
              rutin,
              barang: `Bunga / Admin - ${barang}`,
              kelompok,
              rekening_sumber,
              rekening_masuk: null,
              nominal: bungaNominal,
              nominal_asing: 0,
              kuantitas: 1,
              penyusutan_bunga: 0,
              tanggal,
              relasi_transaksi: '#1',
              attachment: null,
              keterangan,
              review: null,
              created_at
            }
          ]);
          showAlert('Pembayaran pokok & bunga/admin berhasil disimpan.', 'success');
        } else {
          await transaksiModel.insertTransaksi({ ...payload, created_at });
          showAlert('Transaksi berhasil disimpan.', 'success');
        }
      }

      window.location.hash = '#/transactions';
    } catch (err) {
      console.error('Gagal menyimpan transaksi:', err);
      showAlert(err?.message || 'Gagal menyimpan transaksi.', 'danger');
      submitBtn.disabled = false;
      submitBtn.value = isEdit ? 'Perbarui Transaksi' : 'Catat Transaksi';
    }
  }, { signal });
}

export function unmount() {
  cleanupResources();
}
