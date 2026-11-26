import { JENIS_TRANSAKSI } from '../config.js';
import { escapeHtml, formatIDR, formatDBDate, toDateShortMonth, showAlert, ensurePdfJs } from '../utils.js';
import * as transaksiModel from '../models/transaksi.js';
import * as rekeningModel from '../models/rekening.js';
import { downloadAttachment, uploadAttachment } from '../sync/gdrive.js';

export const title = 'Dashboard Transaksi';

let abortController = null;
let flatpickrInstance = null;
let dtTable = null;
let cashFlowChart = null;
let compsChart = null;
let dialogObjectUrls = [];
let dbUpdatedHandler = null;

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
      // Single filename fallback
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

function revokeDialogObjectUrls() {
  for (const url of dialogObjectUrls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Ignore revoke errors
    }
  }
  dialogObjectUrls = [];
}

function destroyCharts() {
  if (cashFlowChart) {
    try {
      cashFlowChart.destroy();
    } catch {
      // Ignore
    }
    cashFlowChart = null;
  }
  if (compsChart) {
    try {
      compsChart.destroy();
    } catch {
      // Ignore
    }
    compsChart = null;
  }
}

function cleanupResources() {
  if (dbUpdatedHandler) {
    window.removeEventListener('kasin:db-updated', dbUpdatedHandler);
    dbUpdatedHandler = null;
  }
  const dialogEl = document.querySelector('#tx-detail-dialog');
  if (dialogEl?.open) {
    try {
      dialogEl.close();
    } catch {
      // Ignore
    }
  }
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  if (dtTable) {
    try {
      dtTable.destroy();
    } catch {
      // Ignore DataTable destroy errors
    }
    dtTable = null;
  }
  if (flatpickrInstance) {
    try {
      flatpickrInstance.destroy();
    } catch {
      // Ignore Flatpickr destroy errors
    }
    flatpickrInstance = null;
  }
  destroyCharts();
  revokeDialogObjectUrls();
}

function enumerateDateRange(startDate, endDate) {
  const days = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) return days;

  let guard = 0;
  while (cursor <= end && guard < 1500) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard += 1;
  }
  return days;
}

function renderCashFlowChart(chartContainer, cashFlowRows, startDate, endDate, onDateClick) {
  if (!chartContainer) return;
  if (cashFlowChart) {
    try {
      cashFlowChart.destroy();
    } catch {
      // Ignore
    }
    cashFlowChart = null;
  }

  if (!window.Highcharts) {
    chartContainer.innerHTML = '<div class="text-muted text-center py-4 small">Highcharts tidak tersedia.</div>';
    return;
  }

  const dayMap = new Map();
  for (const row of cashFlowRows || []) {
    const dateKey = String(row.tanggal || '').slice(0, 10);
    if (!dateKey) continue;
    const entry = dayMap.get(dateKey) || { inRutin: 0, inNon: 0, outRutin: 0, outNon: 0 };
    const amt = Number(row.trans) || 0;
    const isRutin = Boolean(row.rutin);
    if (row.jenis_transaksi === 'Pemasukan') {
      if (isRutin) entry.inRutin += amt;
      else entry.inNon += amt;
    } else if (row.jenis_transaksi === 'Pengeluaran') {
      if (isRutin) entry.outRutin += amt;
      else entry.outNon += amt;
    }
    dayMap.set(dateKey, entry);
  }

  let dateKeys = enumerateDateRange(startDate, endDate);
  if (dateKeys.length === 0) {
    dateKeys = Array.from(dayMap.keys()).sort();
  }

  const sInRutin = [];
  const sInNon = [];
  const sOutRutin = [];
  const sOutNon = [];
  const sCashFlow = [];
  let runningCashFlow = 0;

  for (const day of dateKeys) {
    const ts = Date.parse(`${day}T00:00:00Z`);
    const entry = dayMap.get(day) || { inRutin: 0, inNon: 0, outRutin: 0, outNon: 0 };
    const dayIn = entry.inRutin + entry.inNon;
    const dayOut = entry.outRutin + entry.outNon;
    runningCashFlow += dayIn - dayOut;

    sInRutin.push([ts, entry.inRutin]);
    sInNon.push([ts, entry.inNon]);
    sOutRutin.push([ts, entry.outRutin]);
    sOutNon.push([ts, entry.outNon]);
    sCashFlow.push([ts, runningCashFlow]);
  }

  cashFlowChart = window.Highcharts.chart(chartContainer, {
    title: false,
    chart: { backgroundColor: 'transparent', plotBackgroundColor: 'transparent' },
    credits: { enabled: false },
    xAxis: {
      type: 'datetime',
      title: { text: 'Tanggal' }
    },
    yAxis: {
      title: { text: 'Jumlah (Rp.)' },
      stackLabels: { enabled: true }
    },
    tooltip: { shared: true },
    plotOptions: {
      column: {
        stacking: 'normal',
        borderWidth: 0,
        point: {
          events: {
            click() {
              const dateStr = new Date(this.x).toISOString().slice(0, 10);
              onDateClick?.(dateStr);
            }
          }
        }
      },
      area: {
        stacking: null,
        lineColor: '#666666',
        lineWidth: 4,
        marker: { lineWidth: 4, lineColor: '#666666' }
      }
    },
    series: [
      { name: 'Pemasukan', type: 'column', stack: 'Pemasukan', data: sInRutin },
      { name: 'Pemasukan (Non Rutin)', type: 'column', stack: 'Pemasukan', data: sInNon },
      { name: 'Pengeluaran', type: 'column', stack: 'Pengeluaran', data: sOutRutin },
      { name: 'Pengeluaran (Non Rutin)', type: 'column', stack: 'Pengeluaran', data: sOutNon },
      { name: 'Cash Flow', type: 'line', data: sCashFlow }
    ]
  });
}

function renderCompsTreemap(chartContainer, compsRows, onPointClick) {
  if (!chartContainer) return;
  if (compsChart) {
    try {
      compsChart.destroy();
    } catch {
      // Ignore
    }
    compsChart = null;
  }

  if (!window.Highcharts) {
    chartContainer.innerHTML = '<div class="text-muted text-center py-4 small">Highcharts tidak tersedia.</div>';
    return;
  }

  const data = (compsRows || [])
    .map((r) => ({
      name: String(r.name || 'Lainnya'),
      value: Number(r.value) || 0,
      color: r.color || '#f44336aa'
    }))
    .filter((p) => p.value > 0);

  compsChart = window.Highcharts.chart(chartContainer, {
    chart: { type: 'treemap', backgroundColor: 'transparent', plotBackgroundColor: 'transparent' },
    credits: { enabled: false },
    tooltip: { pointFormat: '<b>{point.name}</b>: {point.value:,.0f}' },
    series: [{
      type: 'treemap',
      layoutAlgorithm: 'squarified',
      data
    }],
    title: false,
    plotOptions: {
      treemap: {
        point: {
          events: {
            click() {
              onPointClick?.(this.name, this.color === '#03a9f4aa');
            }
          }
        }
      }
    }
  });
}

export async function mount(container, params = new URLSearchParams()) {
  cleanupResources();
  abortController = new AbortController();
  const { signal } = abortController;

  const now = new Date();
  const dateRange = [
    new Date(now.getFullYear(), now.getMonth(), 1),
    now
  ];
  let startDate = formatDBDate(dateRange[0]);
  let endDate = formatDBDate(dateRange[1]);

  const filterRekeningId = params?.get('rekening') ? String(params.get('rekening')).trim() : '';

  container.innerHTML = `
    <div class="container-fluid px-md-5">
      <div class="card card-saldo">
        <div>Saldo Efektif</div>
        <h3 class="saldo" id="text-saldo">Rp 0</h3>
        <hr>
        <a href="#/rekening">
          <span>Semua Rekening</span>
          &#10097;
        </a>
      </div>

      <div class="container mb-3">
        <hr>
        <div class="row">
          <div class="col-md-12 mb-2">
            <div class="date-range input-group">
              <input class="form-control" id="startDate" type="text" placeholder="Mulai" readonly>
              <span class="input-group-text">s/d</span>
              <input class="form-control" id="endDate" type="text" placeholder="Akhir" readonly>
            </div>
          </div>
          <div class="col-md-12 card p-3 text-center">
            <div style="font-size:1.2em;">
              <span class="text-success"><b id="text-pemasukan">Rp 0</b>&nbsp;<small>(Pemasukan&nbsp;&#9989;)</small></span>
              |
              <span class="text-danger"><b id="text-pengeluaran">Rp 0</b>&nbsp;<small>(Pengeluaran&nbsp;&#10060;)</small></span>
              |
              <span class="text-warning"><b id="text-net">Rp 0</b>&nbsp;<small>(Net&nbsp;Cashflow&nbsp;&#128176;)</small></span>
            </div>
          </div>
          <div class="col-md-6 card">
            <div class="card-body">
              <h6 class="text-center card-title">Tren Cashflow</h6>
              <div id="arusKasChart"></div>
            </div>
          </div>
          <div class="col-md-6 card">
            <div class="card-body">
              <h6 class="text-center card-title">Komposisi Pengeluaran Berdasarkan Kelompok</h6>
              <div id="treemapChart"></div>
            </div>
          </div>
        </div>
      </div>

      <div class="table-wrapper">
        <table data-label="List Transaksi" class="table table-responsive myTable border-bottom display" id="FormatTable">
          <thead class="sticky-top">
            <tr>
              <th scope="col">ID</th>
              <th scope="col"></th>
              <th scope="col">Barang / Judul</th>
              <th scope="col">Rekening</th>
              <th scope="col">Nominal</th>
              <th scope="col">Total</th>
              <th scope="col">Rutin</th>
              <th scope="col">Kelompok</th>
              <th scope="col">Tanggal</th>
              <th scope="col">Keterangan</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </div>

    <dialog id="tx-detail-dialog" style="width: min(88dvw, 900px); max-width: 95vw;">
      <div class="dialog-header mb-2">
        <h4 class="fw-bold w-100 text-center" id="dialog-title"></h4>
        <form method="dialog">
          <button type="submit" aria-label="Tutup"><i class="fas fs-4 fw-bold fa-times"></i></button>
        </form>
      </div>
      <div class="dialog-body row flex-row">
        <div class="col-md-8" id="dialog-detail-col"></div>
        <div class="col-md-4">
          <form id="form" style="--primary-color:var(--secondary-color)">
            <input type="hidden" name="id">
            <div class="form-group">
              <label class="fw-bold small text-secondary">Review / Catatan</label>
              <textarea name="review" class="form-control mt-1 border-bottom border-primary mb-2" autocomplete="off" placeholder="Tulis review atau catatan transaksi..." rows="3"></textarea>

              <label class="fw-bold small text-secondary mt-1 d-flex justify-content-between align-items-center">
                <span><i class="fas fa-camera me-1"></i> Tambah Lampiran / Foto</span>
                <small id="modal-attachment-info" class="text-primary fw-normal" style="display:none;"></small>
              </label>
              <input type="file" name="attachment[]" id="modal-attachment" multiple accept="image/*, application/pdf" class="form-control form-control-sm mb-2" />

              <input type="submit" class="btn w-100 btn-secondary mt-1" value="Simpan Review & Lampiran" name="record">
              <a href="#/record" class="btn btn-outline-primary w-100 mt-2" id="dialog-edit-link">
                <i class="fas fa-pen me-1"></i>Edit Transaksi
              </a>
              <hr>
              <button type="button" class="btn w-100" style="--primary-color:var(--red-color)" id="btn-delete">Hapus <i class="fas fa-trash-alt"></i></button>
            </div>
          </form>
          <div id="attachment-gallery-container" class="mt-2 text-center" style="display:none;">
            <div class="d-flex justify-content-between align-items-center mb-1">
              <small class="fw-bold text-secondary" id="attachment-counter"><i class="fas fa-paperclip"></i> Lampiran (<span id="attachment-idx">1</span>/<span id="attachment-total">1</span>)</small>
              <a id="attachment-open-btn" href="#" target="_blank" class="btn btn-sm btn-outline-primary py-0 px-2" style="font-size: 0.75rem;">
                Buka File <i class="fas fa-external-link-alt"></i>
              </a>
            </div>
            <div class="border rounded p-1 bg-light position-relative" style="min-height: 80px; overflow: hidden;">
              <a id="attachment" href="#" target="_blank">
                <canvas id="preview-canvas" class="img-fluid" style="display:none; max-height: 380px; margin: 0 auto;"></canvas>
              </a>
            </div>
            <div id="attachment-selector" class="d-flex flex-wrap gap-1 justify-content-center mt-2" style="display:none;"></div>
          </div>
        </div>
        <div class="col-12 mt-3" id="dialog-related-section" style="display:none;">
          <hr>
          <div class="d-flex justify-content-between align-items-center mb-2">
            <h6 class="fw-bold text-primary mb-0"><i class="fas fa-layer-group"></i> Transaksi Terkait (<span id="dialog-related-count">0</span>)</h6>
            <div id="dialog-related-total-badge"></div>
          </div>
          <div class="table-responsive">
            <table class="table table-sm table-bordered align-middle text-center mb-0" id="dialog-related-table" style="font-size: 0.85em;">
              <thead class="table-secondary">
                <tr>
                  <th>ID</th>
                  <th>Tipe</th>
                  <th>Barang</th>
                  <th>Rekening</th>
                  <th>Nominal</th>
                  <th>Qty</th>
                  <th>Total</th>
                  <th>Keterangan</th>
                </tr>
              </thead>
              <tbody></tbody>
              <tfoot class="fw-bold bg-light"></tfoot>
            </table>
          </div>
        </div>
      </div>
    </dialog>
  `;

  const startInput = container.querySelector('#startDate');
  const endInput = container.querySelector('#endDate');
  const textSaldoEl = container.querySelector('#text-saldo');
  const textPemasukanEl = container.querySelector('#text-pemasukan');
  const textPengeluaranEl = container.querySelector('#text-pengeluaran');
  const textNetEl = container.querySelector('#text-net');
  const chartCashflowEl = container.querySelector('#arusKasChart');
  const chartCompsEl = container.querySelector('#treemapChart');
  const tableEl = container.querySelector('#FormatTable');

  const MODAL = container.querySelector('#tx-detail-dialog');
  const FORM = MODAL.querySelector('form#form');
  const detailCol = MODAL.querySelector('#dialog-detail-col');
  const relatedSection = MODAL.querySelector('#dialog-related-section');
  const relatedTbody = MODAL.querySelector('#dialog-related-table tbody');
  const relatedTfoot = MODAL.querySelector('#dialog-related-table tfoot');
  const relatedCount = MODAL.querySelector('#dialog-related-count');
  const relatedTotalBadge = MODAL.querySelector('#dialog-related-total-badge');
  const modalAttachmentInput = MODAL.querySelector('#modal-attachment');
  const modalAttachmentInfo = MODAL.querySelector('#modal-attachment-info');
  const editLinkEl = MODAL.querySelector('#dialog-edit-link');
  const deleteBtnEl = MODAL.querySelector('#btn-delete');

  const canvas = MODAL.querySelector('#preview-canvas');
  const ctx = canvas?.getContext('2d');
  const galleryContainer = MODAL.querySelector('#attachment-gallery-container');
  const attachmentSelector = MODAL.querySelector('#attachment-selector');
  const attachmentIdxEl = MODAL.querySelector('#attachment-idx');
  const attachmentTotalEl = MODAL.querySelector('#attachment-total');
  const openBtn = MODAL.querySelector('#attachment-open-btn');
  const attachmentLink = MODAL.querySelector('a#attachment');

  let currentDialogTx = null;

  MODAL?.addEventListener('click', (e) => {
    if (e.target === MODAL) MODAL.close();
  }, { signal });
  MODAL?.addEventListener('close', () => {
    revokeDialogObjectUrls();
  }, { signal });

  modalAttachmentInput?.addEventListener('change', () => {
    const count = modalAttachmentInput.files?.length || 0;
    if (modalAttachmentInfo) {
      if (count > 0) {
        modalAttachmentInfo.textContent = `${count} file dipilih`;
        modalAttachmentInfo.style.display = 'inline';
      } else {
        modalAttachmentInfo.textContent = '';
        modalAttachmentInfo.style.display = 'none';
      }
    }
  }, { signal });

  async function renderDialogAttachment(filename) {
    if (!canvas || !ctx) return;
    canvas.style.display = 'none';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!filename) return;

    try {
      const blob = await downloadAttachment(filename);
      if (signal.aborted || !blob) return;

      const objUrl = URL.createObjectURL(blob);
      dialogObjectUrls.push(objUrl);

      const downloadName = filename.replace(/\.gz$/i, '');
      if (attachmentLink) {
        attachmentLink.href = objUrl;
        attachmentLink.download = downloadName;
      }
      if (openBtn) {
        openBtn.href = objUrl;
        openBtn.download = downloadName;
      }

      const lower = downloadName.toLowerCase();
      const isPdf = blob.type === 'application/pdf' || lower.endsWith('.pdf');
      if (isPdf) {
        const pdfjsLib = await ensurePdfJs();
        if (!pdfjsLib || signal.aborted) return;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 1.5 });
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        await page.render({ canvasContext: ctx, viewport }).promise;
        canvas.style.display = 'block';
      } else {
        const img = new Image();
        img.onload = () => {
          const maxWidth = 600;
          const scale = Math.min(maxWidth / img.width, 1);
          canvas.width = img.width * scale;
          canvas.height = img.height * scale;
          canvas.style.display = 'block';
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        };
        img.src = objUrl;
      }
    } catch (err) {
      console.warn('Gagal merender lampiran:', err);
    }
  }

  async function openDetailDialog(txId, sourceTr = null) {
    const tx = await transaksiModel.getById(txId);
    if (signal.aborted || !tx) return;

    currentDialogTx = tx;
    revokeDialogObjectUrls();

    MODAL.querySelector('#dialog-title').textContent = tx.barang || `#${String(tx.id).padStart(4, '0')}`;
    detailCol.innerHTML = '';
    relatedSection.style.display = 'none';
    relatedTbody.innerHTML = '';
    relatedTfoot.innerHTML = '';

    if (!sourceTr) {
      sourceTr = tableEl?.querySelector(`tbody tr[data-tx-id="${CSS.escape(String(tx.id))}"]`) || null;
    }

    if (sourceTr) {
      sourceTr.querySelectorAll('td').forEach((td) => {
        if (td.dataset.label === 'Keterangan') return;
        const divEl = document.createElement('div');
        divEl.className = 'd-flex flex-row p-3 align-items-center mb-2 border-2 border-bottom border-primary justify-content-between w-100';
        divEl.innerHTML = `<div class="fw-bold">${escapeHtml(td.dataset.label || '')}</div><div>${td.innerHTML}</div>`;
        detailCol.appendChild(divEl);
      });
    } else {
      const accMap = new Map((await rekeningModel.getAll()).map((a) => [String(a.id), a]));
      if (signal.aborted) return;
      const sumberNama = tx.rekening_sumber ? (accMap.get(String(tx.rekening_sumber))?.nama || `#${tx.rekening_sumber}`) : '';
      const masukNama = tx.rekening_masuk ? (accMap.get(String(tx.rekening_masuk))?.nama || `#${tx.rekening_masuk}`) : '';
      const rekText = [sumberNama, masukNama].filter(Boolean).join(' → ') || '-';
      const totalIdr = (Number(tx.nominal) || 0) * (Number(tx.kuantitas) || 1);

      const pairs = [
        ['ID', String(tx.id).padStart(4, '0')],
        ['Jenis Transaksi', tx.jenis_transaksi],
        ['Barang / Judul', tx.barang || '-'],
        ['Rekening', rekText],
        ['Nominal', formatIDR(tx.nominal || 0)],
        ['Total', formatIDR(totalIdr)],
        ['Rutin', tx.rutin ? 'Rutin' : 'Non Rutin'],
        ['Kelompok', tx.kelompok || '-'],
        ['Tanggal', toDateShortMonth(tx.tanggal) || tx.tanggal || '-']
      ];
      for (const [label, val] of pairs) {
        const divEl = document.createElement('div');
        divEl.className = 'd-flex flex-row p-3 align-items-center mb-2 border-2 border-bottom border-primary justify-content-between w-100';
        divEl.innerHTML = `<div class="fw-bold">${escapeHtml(label)}</div><div>${escapeHtml(val)}</div>`;
        detailCol.appendChild(divEl);
      }
    }

    const ketEl = document.createElement('div');
    ketEl.className = 'd-flex flex-row justify-content-between w-100 pt-3 px-5';
    ketEl.innerHTML = `<pre class="no-decoration" style="white-space: pre-wrap;">${escapeHtml(tx.keterangan || '')}</pre>`;
    detailCol.appendChild(ketEl);

    FORM.review.value = tx.review || '';
    FORM.id.value = tx.id;
    editLinkEl.href = `#/record?id=${encodeURIComponent(tx.id)}`;
    if (modalAttachmentInput) modalAttachmentInput.value = '';
    if (modalAttachmentInfo) {
      modalAttachmentInfo.textContent = '';
      modalAttachmentInfo.style.display = 'none';
    }

    canvas.style.display = 'none';
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    if (galleryContainer) galleryContainer.style.display = 'none';
    if (attachmentSelector) {
      attachmentSelector.innerHTML = '';
      attachmentSelector.style.display = 'none';
    }

    const attachments = parseAttachmentList(tx.attachment);
    if (attachments.length > 0) {
      if (galleryContainer) galleryContainer.style.display = 'block';
      if (attachmentTotalEl) attachmentTotalEl.textContent = String(attachments.length);
      if (attachmentIdxEl) attachmentIdxEl.textContent = '1';

      if (attachments.length > 1 && attachmentSelector) {
        attachmentSelector.style.display = 'flex';
        attachments.forEach((attName, idx) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `btn btn-sm ${idx === 0 ? 'btn-primary' : 'btn-outline-secondary'} py-0 px-2`;
          btn.style.fontSize = '0.75rem';
          btn.textContent = `File ${idx + 1}`;
          btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            attachmentSelector.querySelectorAll('button').forEach((b) => {
              b.className = 'btn btn-sm btn-outline-secondary py-0 px-2';
              b.style.fontSize = '0.75rem';
            });
            btn.className = 'btn btn-sm btn-primary py-0 px-2';
            btn.style.fontSize = '0.75rem';
            if (attachmentIdxEl) attachmentIdxEl.textContent = String(idx + 1);
            renderDialogAttachment(attName);
          }, { signal });
          attachmentSelector.appendChild(btn);
        });
      }
      renderDialogAttachment(attachments[0]);
    }

    if (!MODAL.open) {
      MODAL.showModal();
    }

    const family = await transaksiModel.getRelatedFamily(tx.id);
    if (signal.aborted) return;

    if (family && family.count > 1) {
      relatedCount.textContent = String(family.count);
      const hasBoth = family.total_in > 0 && family.total_out > 0;
      relatedTotalBadge.innerHTML = hasBoth
        ? `<span class="badge bg-primary fs-6">Net: ${escapeHtml(formatIDR(family.net))}</span>`
        : `<span class="badge bg-primary fs-6">Grand Total: ${escapeHtml(formatIDR(family.total))}</span>`;

      const typeColor = { Pengeluaran: 'danger', Pemasukan: 'success', 'Pindah Buku': 'warning' };
      relatedTbody.innerHTML = family.data.map((m) => {
        const isCurrent = String(m.id) === String(tx.id);
        const relRek = [m.nama_rekening_sumber, m.nama_rekening_masuk].filter(Boolean).join(' → ') || '-';
        const color = typeColor[m.jenis_transaksi] || 'secondary';
        const rowTotal = (Number(m.nominal) || 0) * (Number(m.kuantitas) || 1);
        return `
          <tr class="${isCurrent ? 'table-primary fw-semibold' : ''}" data-related-id="${escapeHtml(m.id)}" style="cursor: pointer;">
            <td>#${escapeHtml(String(m.id).padStart(4, '0'))}${isCurrent ? ' <span class="badge bg-primary">Saat Ini</span>' : ''}</td>
            <td><span class="badge bg-${color}">${escapeHtml(m.jenis_transaksi)}</span></td>
            <td class="text-start">${escapeHtml(m.barang || '-')}</td>
            <td class="small">${escapeHtml(relRek)}</td>
            <td class="text-end">${escapeHtml(formatIDR(m.nominal || 0))}</td>
            <td>${escapeHtml(m.kuantitas ?? 1)}</td>
            <td class="text-end fw-bold">${escapeHtml(formatIDR(rowTotal))}</td>
            <td class="text-start small text-muted">${escapeHtml(m.keterangan || '-')}</td>
          </tr>
        `;
      }).join('');

      if (hasBoth) {
        const netClass = family.net >= 0 ? 'text-success' : 'text-danger';
        relatedTfoot.innerHTML = `
          <tr>
            <td colspan="6" class="text-end text-muted small">Total Pemasukan:</td>
            <td colspan="2" class="text-end text-success">${escapeHtml(formatIDR(family.total_in))}</td>
          </tr>
          <tr>
            <td colspan="6" class="text-end text-muted small">Total Pengeluaran:</td>
            <td colspan="2" class="text-end text-danger">-${escapeHtml(formatIDR(family.total_out))}</td>
          </tr>
          <tr class="table-light">
            <td colspan="6" class="text-end text-uppercase">NET TOTAL:</td>
            <td colspan="2" class="text-end ${netClass} fs-6">${escapeHtml(formatIDR(family.net))}</td>
          </tr>
        `;
      } else {
        relatedTfoot.innerHTML = `
          <tr>
            <td colspan="6" class="text-end text-uppercase">TOTAL KESELURUHAN:</td>
            <td colspan="2" class="text-end text-primary fs-6">${escapeHtml(formatIDR(family.total))}</td>
          </tr>
        `;
      }

      relatedTbody.querySelectorAll('[data-related-id]').forEach((rowEl) => {
        rowEl.addEventListener('click', () => {
          const relId = rowEl.getAttribute('data-related-id');
          if (relId && String(relId) !== String(tx.id)) {
            openDetailDialog(relId);
          }
        }, { signal });
      });

      relatedSection.style.display = 'block';
    }
  }

  // Initialize DataTables 2 + Responsive
  if (window.DataTable && tableEl) {
    dtTable = new window.DataTable(tableEl, {
      dom: 'ftpl',
      language: {
        lengthMenu: 'Per _MENU_ Data',
        zeroRecords: 'Tidak ada transaksi',
        infoEmpty: 'Tidak ada transaksi',
        search: '',
        paginate: {
          first: '⇚',
          last: '⇛',
          next: '⇒',
          previous: '⇐'
        }
      },
      bInfo: false,
      responsive: true,
      pageLength: 25,
      lengthMenu: [10, 25, 50, 100],
      order: [[0, 'desc']],
      columnDefs: [
        { responsivePriority: 2, targets: 0 },
        { responsivePriority: 1, targets: [1, 3, 4, 7, 8] },
        { responsivePriority: 0, targets: [2, 5] },
        { targets: 2, className: 'text-wrap' }
      ],
      columns: [
        {
          data: 'id',
          width: '5%',
          render: (val) => escapeHtml(String(val || '').padStart(4, '0'))
        },
        {
          data: 'jenis_transaksi',
          orderable: false,
          render: (data, type) => {
            if (type !== 'display') return String(data || '');
            const styles = {
              Pengeluaran: { icon: 'fa-arrow-circle-down', color: 'danger' },
              Pemasukan: { icon: 'fa-arrow-circle-up', color: 'success' },
              'Pindah Buku': { icon: 'fa-exchange-alt', color: 'warning' }
            };
            const style = styles[data] || { icon: 'fa-circle', color: 'secondary' };
            const labelUpper = String(data || '').toUpperCase();
            return `
              <span class="badge bg-${style.color} d-none d-md-inline-block ms-1">${escapeHtml(labelUpper)}</span>
              <span class="text-${style.color} d-inline-block d-md-none ms-1 align-middle" title="${escapeHtml(labelUpper)}">
                <i class="fas ${style.icon} fs-5"></i>
              </span>
            `;
          }
        },
        {
          data: 'barang',
          title: 'Barang / Jasa',
          render: (data, _type, row) => {
            const hartaBadge = row.harta ? '<span class="badge rounded-pill bg-danger ms-1">Properti</span>' : '';
            const penyusutanVal = Number(row.penyusutan_bunga) || 0;
            const bunga = penyusutanVal !== 0
              ? `<div class="kuitansi small fst-italic ${penyusutanVal > 0 ? 'text-success' : 'text-danger'}">Rp.${escapeHtml(penyusutanVal.toLocaleString('id-ID'))}/bln</div>`
              : '';
            const relas = row.relasi_transaksi
              ? `<div><a href="#/transactions?id=${encodeURIComponent(row.relasi_transaksi)}" data-jump-tx="${escapeHtml(row.relasi_transaksi)}" class="kuitansi small"><i class="fas fa-link"></i> trx.${escapeHtml(row.relasi_transaksi)}</a></div>`
              : '';
            return `<strong>${escapeHtml(data || '-')}${hartaBadge}</strong>${bunga}${relas}`;
          }
        },
        {
          data: null,
          render: (_d, type, row) => {
            if (type === 'filter' || type === 'search') {
              return [row.nama_rekening_sumber, row.nama_rekening_masuk].filter(Boolean).join(' ');
            }
            let html = '';
            const rsAset = Number(row.rs_aset) === 1 ? ' <small class="text-warning fas fa-coins"></small>' : '';
            if (row.nama_rekening_sumber) {
              html += `<div class="fw-bold text-danger"><i class="fas fa-sign-out-alt"></i>&nbsp;${escapeHtml(row.nama_rekening_sumber)}${rsAset}</div>`;
            }
            const rmAset = Number(row.rm_aset) === 1 ? ' <small class="text-warning fas fa-coins"></small>' : '';
            if (row.nama_rekening_masuk) {
              html += `<div class="fw-bold text-success"><i class="fas fa-sign-in-alt"></i>&nbsp;${escapeHtml(row.nama_rekening_masuk)}${rmAset}</div>`;
            }
            return html || '-';
          }
        },
        {
          data: 'nominal',
          render: (val, type, row) => {
            if (type === 'sort' || type === 'type') return Number(val) || 0;
            const nomIdr = Number(val || 0).toLocaleString('id-ID');
            if (row.mata_uang && row.mata_uang.length > 0) {
              const nomAsing = Number(row.nominal_asing || 0).toLocaleString('id-ID');
              return `
                <div class="nominal fw-bold text-primary">${escapeHtml(nomAsing)},- ${escapeHtml(row.mata_uang)}</div>
                <div class="small text-secondary">Rp.&nbsp;${escapeHtml(nomIdr)},-</div>
              `;
            }
            return `<div class="nominal fw-bold text-primary">Rp.&nbsp;${escapeHtml(nomIdr)},-</div>`;
          }
        },
        {
          data: null,
          render: (_d, type, row) => {
            const qty = Number(row.kuantitas) || 1;
            const totalIdr = (Number(row.nominal) || 0) * qty;
            if (type === 'sort' || type === 'type') return totalIdr;
            const textColor = {
              Pengeluaran: 'danger',
              Pemasukan: 'success',
              'Pindah Buku': 'warning'
            };
            const color = textColor[row.jenis_transaksi] || 'secondary';
            const totalIdrFmt = totalIdr.toLocaleString('id-ID');
            if (row.mata_uang && row.mata_uang.length > 0) {
              const totalAsingFmt = ((Number(row.nominal_asing) || 0) * qty).toLocaleString('id-ID');
              return `
                <div class="nominal fw-bold text-${color}">${escapeHtml(totalAsingFmt)},- ${escapeHtml(row.mata_uang)} <span class="small">(${escapeHtml(qty)} Qty)</span></div>
                <div class="small text-secondary">Rp.&nbsp;${escapeHtml(totalIdrFmt)},-</div>
              `;
            }
            return `<div class="nominal fw-bold text-${color}">Rp.&nbsp;${escapeHtml(totalIdrFmt)},- <span class="small">(${escapeHtml(qty)} Qty)</span></div>`;
          }
        },
        {
          data: 'rutin',
          render: (val, type) => {
            if (type === 'filter' || type === 'search') return val ? 'Rutin' : 'Non Rutin';
            return val
              ? '<span class="badge rounded-pill bg-primary">Rutin</span>'
              : '<span class="badge rounded-pill bg-warning">Non Rutin</span>';
          }
        },
        {
          data: 'kelompok',
          render: (val) => (val ? escapeHtml(val) : '<span class="text-muted">-</span>')
        },
        {
          data: 'tanggal',
          render: (val, type) => {
            if (type === 'sort' || type === 'type' || type === 'filter') return String(val || '');
            return escapeHtml(toDateShortMonth(val) || val || '-');
          }
        },
        {
          data: 'keterangan',
          orderable: false,
          render: (val, _t, row) => {
            const attachments = parseAttachmentList(row.attachment);
            const attachBadge = row.attachment === 'uploading'
              ? '<span class="badge bg-warning text-dark me-1"><i class="fas fa-upload"></i></span>'
              : attachments.length > 1
                ? `<span class="badge bg-warning text-dark me-1"><i class="fas fa-paperclip"></i> ${attachments.length}</span>`
                : attachments.length === 1
                  ? '<span class="text-warning me-1"><i class="fas fa-paperclip"></i></span>'
                  : '';
            return `
              <div class="small w-lg-50 text-wrap line-clamp-4">${attachBadge}${escapeHtml(val || '')}</div>
              <div class="small w-lg-50 text-wrap line-clamp-4 text-secondary">${escapeHtml(row.review || '')}</div>
            `;
          }
        }
      ],
      initComplete() {
        const input = container.querySelector('#FormatTable_wrapper .dt-search input');
        if (input) {
          input.placeholder = '🔍 Cari Disini...';
          const resetBtn = document.createElement('button');
          resetBtn.type = 'button';
          resetBtn.id = 'tx-reset-btn';
          resetBtn.className = 'btn btn-sm text-primary';
          resetBtn.title = 'Reset filter & urutan';
          resetBtn.innerHTML = '<i class="fas fa-redo"></i>';
          resetBtn.addEventListener('click', () => {
            const typeSelect = tableEl.querySelector('thead select');
            if (typeSelect) typeSelect.value = '';
            dtTable?.search('').columns().search('').order([[0, 'desc']]).page.len(25).draw();
          }, { signal });
          input.parentElement?.prepend(resetBtn);
        }

        const column = this.api().column(1);
        const select = document.createElement('select');
        select.className = 'form-select form-select-sm bg-transparent fw-bold mx-auto border-0 shadow-none text-white';
        select.style.maxWidth = '130px';
        select.style.cursor = 'pointer';
        select.innerHTML = [
          '<option value="" class="text-white fw-bold bg-dark">Semua Tipe</option>',
          ...JENIS_TRANSAKSI.map((x) => `<option value="${escapeHtml(x)}" class="text-white fw-bold bg-dark">${escapeHtml(x)}</option>`)
        ].join('');
        select.addEventListener('change', function () {
          column.search(this.value).draw();
        }, { signal });
        column.header().replaceChildren(select);
      },
      createdRow(rowEl, rowData) {
        rowEl.setAttribute('data-tx-id', String(rowData.id));
        rowEl.style.cursor = 'pointer';
        rowEl.setAttribute('title', 'Klik 2x untuk membuka');
        const cells = rowEl.querySelectorAll('td');
        cells.forEach((td, index) => {
          const label = index === 1 ? 'Jenis Transaksi' : this.api().column(index).header().textContent;
          td.setAttribute('data-label', label);
        });
      }
    });
  }

  async function refreshDashboard() {
    if (signal.aborted) return;

    try {
      const [accounts, rows, cashFlowRows, compsRows] = await Promise.all([
        rekeningModel.getAll(),
        transaksiModel.filter({
          startDate,
          endDate,
          rekening: filterRekeningId || undefined,
          limit: 5000
        }),
        filterRekeningId
          ? transaksiModel.rekeningCashFlowGraph(startDate, endDate, filterRekeningId)
          : transaksiModel.cashFlowGraph(startDate, endDate),
        filterRekeningId
          ? transaksiModel.rekeningCompsGraph(startDate, endDate, filterRekeningId)
          : transaksiModel.compsGraph(startDate, endDate)
      ]);

      if (signal.aborted) return;

      const liquidSaldo = (accounts || [])
        .filter((a) => a.aktif && !a.harta)
        .reduce((acc, a) => acc + (Number(a.saldo) || 0), 0);

      let totalPemasukan = 0;
      let totalPengeluaran = 0;
      for (const r of cashFlowRows || []) {
        const amt = Number(r.trans) || 0;
        if (r.jenis_transaksi === 'Pemasukan') totalPemasukan += amt;
        else if (r.jenis_transaksi === 'Pengeluaran') totalPengeluaran += amt;
      }

      textSaldoEl.textContent = formatIDR(liquidSaldo);
      textPemasukanEl.textContent = formatIDR(totalPemasukan);
      textPengeluaranEl.textContent = formatIDR(totalPengeluaran);
      textNetEl.textContent = formatIDR(totalPemasukan - totalPengeluaran);

      renderCashFlowChart(chartCashflowEl, cashFlowRows, startDate, endDate, (dateStr) => {
        dtTable?.columns().search('').column(8).search(dateStr).draw();
      });
      renderCompsTreemap(chartCompsEl, compsRows, (name, isRutin) => {
        dtTable?.columns().search('')
          .column(1).search('Pengeluaran')
          .column(7).search(name)
          .column(6).search(isRutin ? '^Rutin$' : 'Non Rutin', true, false)
          .draw();
      });

      if (dtTable) {
        dtTable.clear().rows.add(rows || []).draw(false);
        dtTable.responsive?.recalc();
      }
    } catch (err) {
      console.error('Gagal memuat dashboard transaksi:', err);
      showAlert(err?.message || 'Gagal memuat dashboard transaksi.', 'danger');
    }
  }

  // Flatpickr date range
  if (window.flatpickr && startInput && endInput) {
    const plugins = window.rangePlugin ? [new window.rangePlugin({ input: endInput })] : [];
    flatpickrInstance = window.flatpickr(startInput, {
      disableMobile: true,
      plugins,
      maxDate: 'today',
      dateFormat: 'd M Y',
      defaultDate: dateRange,
      onChange(selectedDates) {
        if (!selectedDates || selectedDates.length === 0) return;
        const start = selectedDates[0];
        const end = selectedDates[1] || start;
        startDate = formatDBDate(start);
        endDate = formatDBDate(end);
        if (selectedDates.length === 2 || plugins.length === 0) {
          refreshDashboard();
        }
      }
    });
  }

  // Double click row -> open <dialog> (and [data-jump-tx] click)
  const tbodyEl = tableEl?.querySelector('tbody');
  tbodyEl?.addEventListener('click', (e) => {
    const jumpEl = e.target.closest('[data-jump-tx]');
    if (jumpEl) {
      e.preventDefault();
      e.stopPropagation();
      const jumpId = jumpEl.getAttribute('data-jump-tx');
      if (jumpId) openDetailDialog(jumpId);
    }
  }, { signal });

  tbodyEl?.addEventListener('dblclick', (e) => {
    if (e.target.closest('a, button, input, td.dtr-control')) return;
    const rowEl = e.target.closest('tr[data-tx-id]');
    if (!rowEl) return;
    const txId = rowEl.getAttribute('data-tx-id');
    if (txId) openDetailDialog(txId, rowEl);
  }, { signal });

  editLinkEl?.addEventListener('click', () => MODAL?.close(), { signal });

  // Inline review & attachment submit inside <dialog>
  FORM?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentDialogTx) return;

    const submitBtn = FORM.record;
    submitBtn.disabled = true;
    submitBtn.value = 'Menyimpan...';

    try {
      const files = Array.from(modalAttachmentInput?.files || []);
      const uploadedNames = [];
      for (const file of files) {
        const savedName = await uploadAttachment(generateAttachmentFilename(file.name), file);
        uploadedNames.push(savedName);
      }

      const existing = parseAttachmentList(currentDialogTx.attachment);
      const merged = [...existing, ...uploadedNames];
      const attachmentValue = merged.length === 0
        ? null
        : merged.length === 1
          ? merged[0]
          : JSON.stringify(merged);

      await transaksiModel.updateTransaksi(currentDialogTx.id, {
        jenis_transaksi: currentDialogTx.jenis_transaksi,
        harta: Boolean(currentDialogTx.harta),
        rutin: Boolean(currentDialogTx.rutin),
        barang: currentDialogTx.barang,
        kelompok: currentDialogTx.kelompok ?? null,
        rekening_sumber: currentDialogTx.rekening_sumber ?? null,
        rekening_masuk: currentDialogTx.rekening_masuk ?? null,
        nominal: Number(currentDialogTx.nominal ?? 0),
        nominal_asing: Number(currentDialogTx.nominal_asing ?? 0),
        kuantitas: Number(currentDialogTx.kuantitas ?? 1),
        penyusutan_bunga: Number(currentDialogTx.penyusutan_bunga ?? 0),
        tanggal: currentDialogTx.tanggal,
        relasi_transaksi: currentDialogTx.relasi_transaksi ?? null,
        attachment: attachmentValue,
        keterangan: currentDialogTx.keterangan ?? null,
        review: FORM.review.value.trim() || null
      });

      window.dispatchEvent(new CustomEvent('kasin:db-updated', { detail: { source: 'review', id: currentDialogTx.id } }));
      showAlert('Review & lampiran berhasil disimpan.', 'success');
      MODAL.close();
      await refreshDashboard();
    } catch (err) {
      console.error('Gagal menyimpan review:', err);
      showAlert(err?.message || 'Gagal menyimpan review & lampiran.', 'danger');
    } finally {
      submitBtn.disabled = false;
      submitBtn.value = 'Simpan Review & Lampiran';
    }
  }, { signal });

  deleteBtnEl?.addEventListener('click', async () => {
    if (!currentDialogTx) return;

    let confirmed = false;
    if (window.Swal?.fire) {
      const result = await window.Swal.fire({
        title: `Hapus ${MODAL.querySelector('#dialog-title').textContent}..?`,
        text: 'Tindakan ini tidak bisa dikembalikan',
        icon: 'warning',
        target: '#tx-detail-dialog',
        showCancelButton: true,
        confirmButtonColor: '#d20f39',
        confirmButtonText: 'Ya, Hapus',
        cancelButtonText: 'Batal'
      });
      confirmed = Boolean(result.isConfirmed);
    } else {
      confirmed = window.confirm(`Hapus transaksi #${String(currentDialogTx.id).padStart(4, '0')}?`);
    }

    if (!confirmed) return;

    try {
      await transaksiModel.deleteTransaksi(currentDialogTx.id);
      MODAL.close();
      showAlert('Transaksi berhasil dihapus.', 'success');
      await refreshDashboard();
    } catch (err) {
      console.error('Gagal menghapus transaksi:', err);
      showAlert(err?.message || 'Gagal menghapus transaksi.', 'danger');
    }
  }, { signal });

  dbUpdatedHandler = () => {
    refreshDashboard();
  };
  window.addEventListener('kasin:db-updated', dbUpdatedHandler);

  await refreshDashboard();

  const deepLinkId = params?.get('id') || params?.get('relasi');
  if (deepLinkId && !signal.aborted) {
    openDetailDialog(deepLinkId);
  }
}

export function unmount() {
  cleanupResources();
}
