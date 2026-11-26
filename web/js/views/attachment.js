import { escapeHtml } from '../utils.js';
import * as transaksiModel from '../models/transaksi.js';
import { uploadAttachment } from '../sync/gdrive.js';

export const title = 'Unggah Lampiran';

let abortController = null;

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
      // Fallback to single filename string
    }
  }
  return [str];
}

function generateAttachmentFilename(originalName) {
  const cleaned = String(originalName || 'file')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  return `${ts}_${rand}_${cleaned}`;
}

function renderErrorCard(container, message) {
  container.innerHTML = `
    <div class="container d-flex align-items-center justify-content-center py-5">
      <div class="card shadow border-0 p-4 rounded-4" style="max-width: 420px; width: 100%;">
        <div class="card-body text-center">
          <div class="text-danger mb-3">
            <i class="fas fa-exclamation-circle fa-3x"></i>
          </div>
          <h4 class="card-title fw-bold mb-3">Gagal</h4>
          <div class="alert alert-danger py-2 px-3 small mb-3 text-start">
            <i class="fas fa-exclamation-triangle me-1"></i> ${escapeHtml(message)}
          </div>
          <a href="#/transactions" class="btn btn-outline-secondary btn-sm w-100 mt-2">Buka KasIn</a>
        </div>
      </div>
    </div>
  `;
}

export async function mount(container, params = new URLSearchParams()) {
  if (abortController) abortController.abort();
  abortController = new AbortController();
  const { signal } = abortController;

  const rawId = params?.get('id');
  const txId = rawId ? String(rawId).trim() : '';
  if (!txId) {
    renderErrorCard(container, 'ID transaksi tidak ditemukan.');
    return;
  }

  const tx = await transaksiModel.getById(txId);
  if (signal.aborted) return;

  if (!tx) {
    renderErrorCard(container, `Transaksi #${txId} tidak ditemukan.`);
    return;
  }

  const formattedId = String(tx.id).padStart(4, '0');

  container.innerHTML = `
    <div class="container d-flex align-items-center justify-content-center py-5">
      <div class="card shadow border-0 p-4 rounded-4" style="max-width: 420px; width: 100%;">
        <div class="card-body text-center">
          <div id="upload-section">
            <div class="text-primary mb-3">
              <i class="fas fa-file-upload fa-3x"></i>
            </div>
            <h4 class="card-title fw-bold mb-2">Unggah Lampiran</h4>
            <p class="text-secondary small mb-4">Transaksi #${escapeHtml(formattedId)} &bull; ${escapeHtml(tx.barang || '')}</p>

            <div id="upload-alert" class="alert alert-danger py-2 px-3 small mb-3 text-start d-none"></div>

            <form id="upload-form">
              <input type="file" class="form-control d-none" accept="image/*,application/pdf" id="attachment" multiple />
              <label for="attachment" class="btn btn-primary w-100" id="select-btn">
                <i class="fas fa-images me-1"></i> Pilih &amp; Unggah File
              </label>
            </form>
            <a href="#/transactions?id=${encodeURIComponent(tx.id)}" class="btn btn-outline-secondary btn-sm w-100 mt-3">Kembali</a>
          </div>

          <div id="success-section" class="d-none">
            <div class="text-success mb-3">
              <i class="fas fa-check-circle fa-3x"></i>
            </div>
            <h4 class="card-title fw-bold mb-3">Upload Berhasil!</h4>
            <div class="alert alert-success py-2 px-3 small mb-3 text-start">
              <i class="fas fa-info-circle me-1"></i> Lampiran tersimpan untuk Transaksi #${escapeHtml(formattedId)}.
            </div>
            <a href="#/transactions?id=${encodeURIComponent(tx.id)}" class="btn btn-primary w-100">Lihat Transaksi</a>
            <a href="#/transactions" class="btn btn-outline-secondary btn-sm w-100 mt-2">Buka KasIn</a>
          </div>
        </div>
      </div>
    </div>
  `;

  const fileInput = container.querySelector('#attachment');
  const selectBtn = container.querySelector('#select-btn');
  const uploadAlert = container.querySelector('#upload-alert');
  const uploadSection = container.querySelector('#upload-section');
  const successSection = container.querySelector('#success-section');

  fileInput?.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    if (files.length === 0) return;

    const originalBtnHtml = selectBtn.innerHTML;
    selectBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Mengunggah ${files.length} file...`;
    selectBtn.classList.add('disabled');
    uploadAlert?.classList.add('d-none');

    try {
      const uploadedNames = [];
      for (const file of files) {
        const targetName = generateAttachmentFilename(file.name);
        const savedName = await uploadAttachment(targetName, file);
        uploadedNames.push(savedName);
      }

      const existing = parseAttachmentList(tx.attachment);
      const merged = [...existing, ...uploadedNames];
      const attachmentValue = merged.length === 0
        ? null
        : merged.length === 1
          ? merged[0]
          : JSON.stringify(merged);

      await transaksiModel.updateTransaksi(tx.id, {
        jenis_transaksi: tx.jenis_transaksi,
        harta: Boolean(tx.harta),
        rutin: Boolean(tx.rutin),
        barang: tx.barang,
        kelompok: tx.kelompok ?? null,
        rekening_sumber: tx.rekening_sumber ?? null,
        rekening_masuk: tx.rekening_masuk ?? null,
        nominal: Number(tx.nominal ?? 0),
        nominal_asing: Number(tx.nominal_asing ?? 0),
        kuantitas: Number(tx.kuantitas ?? 1),
        penyusutan_bunga: Number(tx.penyusutan_bunga ?? 0),
        tanggal: tx.tanggal,
        relasi_transaksi: tx.relasi_transaksi ?? null,
        attachment: attachmentValue,
        keterangan: tx.keterangan ?? null,
        review: tx.review ?? null
      });

      window.dispatchEvent(new CustomEvent('kasin:db-updated', { detail: { source: 'attachment', id: tx.id } }));

      if (signal.aborted) return;
      uploadSection?.classList.add('d-none');
      successSection?.classList.remove('d-none');
    } catch (err) {
      if (signal.aborted) return;
      selectBtn.innerHTML = originalBtnHtml;
      selectBtn.classList.remove('disabled');
      fileInput.value = '';
      if (uploadAlert) {
        uploadAlert.textContent = err?.message || 'Terjadi kesalahan saat upload.';
        uploadAlert.classList.remove('d-none');
      }
    }
  }, { signal });
}

export function unmount() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
}
