import { getGoogleClientId, setGoogleClientId } from '../config.js';
import { escapeHtml, formatDBDate, parseCSVLine, parseFlexibleDate, showAlert } from '../utils.js';
import { db } from '../db/client.js';
import {
  isFileSystemAccessSupported,
  connectLocalSqliteFile,
  getConnectedLocalFile,
  disconnectLocalFile
} from '../db/local-file.js';
import * as transaksiModel from '../models/transaksi.js';
import * as gdrive from '../sync/gdrive.js';
import { signInGoogleWithProtection, guardLocalImportWhileSignedIn } from '../sync/guard.js';

export const title = 'Databases & Sync';

const STYLE_ID = 'kasin-databases-styles';
const DATABASES_CSS = `
  .db-title {
    color: var(--primary-color);
    font-family: var(--font-head);
  }
  .db-card {
    border: 1px solid color-mix(in srgb, var(--primary-color) 22%, transparent);
    border-radius: 12px;
    background-color: var(--bg-color);
    box-shadow: 0 2px 10px color-mix(in srgb, var(--shadow-color, var(--black-color)) 8%, transparent);
  }
  .db-btn-primary {
    background-color: var(--primary-color);
    color: var(--white-color);
    border: none;
  }
  .db-btn-primary:disabled {
    background-color: var(--primary-color);
    color: var(--white-color);
    opacity: 0.65;
  }
  .db-btn-primary:hover,
  .db-btn-primary:focus {
    background-color: var(--primary-color-alt);
    color: var(--white-color);
  }
  .db-btn-outline {
    background-color: transparent;
    color: var(--primary-color);
    border: 1.5px solid var(--primary-color);
  }
  .db-btn-outline:hover,
  .db-btn-outline:focus {
    background-color: color-mix(in srgb, var(--primary-color) 10%, transparent);
    color: var(--primary-color-alt);
  }
  .db-btn-success {
    background-color: var(--green-color);
    color: var(--white-color);
    border: none;
  }
  .db-btn-success:hover,
  .db-btn-success:focus {
    background-color: color-mix(in srgb, var(--green-color) 88%, var(--black-color));
    color: var(--white-color);
  }
  .db-btn-warning {
    background-color: transparent;
    color: var(--yellow-color);
    border: 1.5px solid var(--yellow-color);
  }
  .db-btn-warning:hover,
  .db-btn-warning:focus {
    background-color: color-mix(in srgb, var(--yellow-color) 12%, transparent);
    color: var(--yellow-color);
  }
  .db-btn-danger {
    background-color: transparent;
    color: var(--red-color);
    border: 1.5px solid var(--red-color);
  }
  .db-btn-danger:hover,
  .db-btn-danger:focus {
    background-color: var(--red-color);
    color: var(--white-color);
  }
  .db-input {
    border: none;
    border-bottom: 2px solid color-mix(in srgb, var(--primary-color) 50%, transparent);
    border-radius: 6px 6px 0 0;
    font-weight: 500;
  }
  .db-input:focus {
    border-bottom-color: var(--primary-color);
    box-shadow: none;
  }
  .db-details {
    border: 1px solid color-mix(in srgb, var(--primary-color) 22%, transparent);
    border-radius: 10px;
    background-color: var(--white-color-0);
  }
`;

const MAX_CSV_IMPORT_ROWS = 15;
const SQLITE_MAGIC = 'SQLite format 3\0';
const CSV_COLS = [
  'id', 'tanggal', 'jenis_transaksi', 'harta', 'barang', 'rekening_sumber',
  'nama_rekening_sumber', 'rekening_masuk', 'nama_rekening_masuk', 'nominal',
  'nominal_asing', 'kuantitas', 'penyusutan_bunga', 'rutin', 'kelompok',
  'relasi_transaksi', 'attachment', 'keterangan', 'review', 'created_at'
];
const CSV_UPDATABLE = new Set([
  'jenis_transaksi', 'harta', 'barang', 'rekening_sumber', 'rekening_masuk',
  'nominal', 'nominal_asing', 'kuantitas', 'penyusutan_bunga', 'rutin',
  'kelompok', 'tanggal', 'relasi_transaksi', 'attachment', 'keterangan', 'review'
]);
const FLOAT_COLS = new Set(['nominal', 'nominal_asing', 'kuantitas', 'penyusutan_bunga']);
const INT_COLS = new Set(['rekening_sumber', 'rekening_masuk', 'relasi_transaksi']);
const BOOL_COLS = new Set(['harta', 'rutin']);

let isMounted = false;
let rootContainer = null;
let datePicker = null;
let dbUpdatedHandler = null;
let currentStartDate = '';
let currentEndDate = '';

const $ = (sel) => rootContainer?.querySelector(sel);

function formatStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename, style: 'display:none' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function runAction(btn, fn, errPrefix = 'Gagal') {
  if (btn) btn.disabled = true;
  try {
    await fn();
  } catch (err) {
    showAlert(`${errPrefix}: ${err?.message || err}`, 'danger');
  } finally {
    if (btn && isMounted) btn.disabled = false;
    refreshSyncStatus();
  }
}

async function confirmDialog({ title: dlgTitle, text, icon = 'warning', confirmButtonText = 'Ya, Lanjutkan', confirmButtonColor = '#04a5e5' }) {
  if (window.Swal?.fire) {
    const res = await window.Swal.fire({
      title: dlgTitle, text, icon, showCancelButton: true,
      confirmButtonText, cancelButtonText: 'Batal', confirmButtonColor, reverseButtons: true
    });
    return Boolean(res.isConfirmed);
  }
  return window.confirm(`${dlgTitle}\n\n${text}`);
}

const quoteCSV = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function parseCSV(text) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  if (!lines.length) return { headers: [], rows: [], delimiter: ',' };
  let idx = 0;
  let delim = null;
  const sep = /^sep\s*=\s*(.)/i.exec(lines[0].trim());
  if (sep) {
    delim = sep[1] === '\\t' ? '\t' : sep[1];
    idx = 1;
  }
  if (idx >= lines.length) return { headers: [], rows: [], delimiter: delim || ',' };
  if (!delim) {
    delim = [',', ';', '\t'].reduce((b, d) => (parseCSVLine(lines[idx], d).length > parseCSVLine(lines[idx], b).length ? d : b), ',');
  }
  const headers = parseCSVLine(lines[idx], delim).map((h) => h.trim().toLowerCase());
  const rows = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const cells = parseCSVLine(lines[i], delim);
    if (cells.every((c) => c.trim() === '')) continue;
    const rec = {};
    headers.forEach((k, c) => { if (k) rec[k] = cells[c] !== undefined ? cells[c].trim() : ''; });
    rows.push(rec);
  }
  return { headers, rows, delimiter: delim };
}

function parseLocalizedNumber(raw, delim) {
  let norm = String(raw ?? '').trim();
  if (!norm) return null;
  if (delim !== ',' && norm.includes(',')) norm = norm.replace(/\./g, '').replace(',', '.');
  else if (delim === ',' && /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(norm)) norm = norm.replace(/,/g, '');
  const num = Number(norm);
  return Number.isFinite(num) ? num : null;
}

function buildCSVPayload(row, delim) {
  const payload = {};
  for (const [col, raw] of Object.entries(row)) {
    if (!CSV_UPDATABLE.has(col)) continue;
    if (col === 'tanggal') {
      const d = parseFlexibleDate(raw);
      if (d) payload.tanggal = d;
    } else if (BOOL_COLS.has(col)) {
      if (raw !== '') payload[col] = ['1', 'true', 'ya', 'yes'].includes(raw.toLowerCase());
    } else if (FLOAT_COLS.has(col)) {
      const n = raw === '' ? 0 : parseLocalizedNumber(raw, delim);
      if (n !== null) payload[col] = n;
    } else if (INT_COLS.has(col)) {
      const n = raw === '' ? null : Number.parseInt(raw, 10);
      if (n === null || Number.isFinite(n)) payload[col] = n;
    } else {
      payload[col] = raw === '' ? null : raw;
    }
  }
  return payload;
}

async function refreshSyncStatus() {
  if (!isMounted || !rootContainer) return;
  const state = gdrive.getSyncState();
  let storageMode = 'unavailable';
  try { storageMode = await db.getStorageMode(); } catch { /* ignore */ }
  if (!isMounted || !rootContainer) return;

  const badge = $('#db-drive-status-badge');
  if (badge) {
    const [cls, label] = !navigator.onLine
      ? ['text-bg-warning', 'Offline']
      : state.signedIn
        ? ['text-bg-success', 'Tersambung']
        : ['text-bg-secondary', 'Lokal'];
    badge.className = `badge ${cls}`;
    badge.textContent = label;
  }

  const modeEl = $('#db-storage-mode');
  if (modeEl) modeEl.textContent = storageMode;
  const lastEl = $('#db-drive-last-synced');
  if (lastEl) lastEl.textContent = state.lastSyncedAt || 'Belum pernah sinkronisasi';

  const pendingEl = $('#db-drive-pending-badge');
  if (pendingEl) {
    pendingEl.classList.toggle('d-none', !(state.pendingDeltas > 0));
    if (state.pendingDeltas > 0) pendingEl.textContent = `${state.pendingDeltas} pending delta`;
  }

  const signInBtn = $('#btn-drive-signin');
  const syncBtn = $('#btn-drive-sync');
  const signOutBtn = $('#btn-drive-signout');
  const compactBtn = $('#btn-drive-compact');
  if (signInBtn) { signInBtn.classList.toggle('d-none', state.signedIn); signInBtn.disabled = !state.configured; }
  if (syncBtn) { syncBtn.classList.toggle('d-none', !state.signedIn); syncBtn.disabled = !state.signedIn; }
  if (signOutBtn) { signOutBtn.classList.toggle('d-none', !state.signedIn); signOutBtn.disabled = !state.signedIn; }
  if (compactBtn) compactBtn.disabled = !state.signedIn;
}

async function resolveDriveConflict(info) {
  if (window.Swal?.fire) {
    const res = await window.Swal.fire({
      title: 'Konflik Sinkronisasi Google Drive',
      text: `Salinan Drive (${info.remoteModifiedTime || 'baru'}) lebih baru dari lokal (${info.localModifiedTime || 'tidak diketahui'}). Pilih tindakan:`,
      icon: 'warning', showCancelButton: true, showDenyButton: true,
      confirmButtonText: 'Timpa Drive', denyButtonText: 'Muat Salinan Drive', cancelButtonText: 'Batal',
      confirmButtonColor: '#d20f39', denyButtonColor: '#04a5e5'
    });
    if (res.isConfirmed) {
      const forced = await gdrive.saveToDrive({ force: true });
      if (forced?.status === 'saved') showAlert('Database lokal menimpa salinan Drive.', 'success');
    } else if (res.isDenied) {
      const pulled = await gdrive.pullIfNewer({ force: true });
      if (pulled?.status === 'pulled') showAlert('Salinan Google Drive berhasil dimuat.', 'success');
    }
    return;
  }
  if (window.confirm('Konflik sinkronisasi. OK untuk timpa Drive dengan data lokal?')) {
    await gdrive.saveToDrive({ force: true });
    showAlert('Database lokal menimpa salinan Drive.', 'success');
  }
}

async function handleDriveSync() {
  const state = gdrive.getSyncState();
  const res = (state.dirty || state.pendingDeltas > 0) ? await gdrive.saveToDrive() : await gdrive.pullIfNewer();
  if (!isMounted) return;
  if (res?.status === 'conflict') await resolveDriveConflict(res);
  else if (res?.status === 'saved') showAlert('Database berhasil disimpan ke Google Drive.', 'success');
  else if (res?.status === 'pulled') showAlert('Database terbaru dimuat dari Google Drive.', 'success');
  else if (res?.status === 'offline') showAlert('Sedang offline. Perubahan ditandai untuk sinkronisasi nanti.', 'warning');
  else if (res?.status === 'unauthenticated') showAlert('Silakan masuk ke Google Drive terlebih dahulu.', 'warning');
  else showAlert('Database sudah sinkron dengan Google Drive.', 'info');
}

async function handleDownloadCSV() {
  if (!currentStartDate || !currentEndDate) {
    showAlert('Silakan pilih rentang tanggal terlebih dahulu.', 'warning');
    return;
  }
  const rows = await transaksiModel.getInRange(currentStartDate, currentEndDate);
  if (!isMounted) return;
  const lines = ['sep=,', CSV_COLS.map(quoteCSV).join(',')];
  for (const r of rows || []) lines.push(CSV_COLS.map((c) => quoteCSV(r[c])).join(','));
  downloadBlob(new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8;' }), `kasin_export_${formatStamp()}.csv`);
  showAlert(`Berhasil mengekspor ${rows?.length || 0} transaksi ke CSV.`, 'success');
}

async function handleImportCSV(event) {
  const input = event.target;
  const file = input?.files?.[0];
  if (!file) return;
  try {
    const { headers, rows, delimiter } = parseCSV(await file.text());
    if (!isMounted) return;
    if (!headers.includes('id') || !rows.length) {
      showAlert('File CSV tidak valid atau tidak memiliki kolom "id" dan data.', 'warning');
      return;
    }
    const valid = rows
      .filter((r) => r.id && /^\d+$/.test(String(r.id).trim()))
      .map((r) => ({ id: Number.parseInt(r.id, 10), payload: buildCSVPayload(r, delimiter) }))
      .filter((x) => Object.keys(x.payload).length > 0);
    if (!valid.length) {
      showAlert('Tidak ada baris valid dengan ID numerik dan kolom yang dapat diperbarui.', 'warning');
      return;
    }
    const batch = valid.slice(0, MAX_CSV_IMPORT_ROWS);
    const note = valid.length > MAX_CSV_IMPORT_ROWS ? ` (dibatasi ${MAX_CSV_IMPORT_ROWS} dari ${valid.length} baris)` : '';
    const ok = await confirmDialog({
      title: 'Konfirmasi Impor CSV', text: `Perbarui ${batch.length} transaksi berdasarkan ID${note}?`,
      icon: 'question', confirmButtonText: 'Ya, Perbarui'
    });
    if (!ok || !isMounted) return;

    let updated = 0;
    for (const item of batch) {
      const res = await transaksiModel.updateTransaksi(item.id, item.payload);
      if (res?.changes > 0) updated += 1;
    }
    window.dispatchEvent(new CustomEvent('kasin:db-updated'));
    showAlert(`Impor CSV selesai: ${updated} dari ${batch.length} transaksi diperbarui.`, 'success');
  } catch (err) {
    showAlert(`Gagal mengimpor CSV: ${err?.message || err}`, 'danger');
  } finally {
    if (input) input.value = '';
  }
}

async function handleRestoreSqlite(event) {
  const input = event.target;
  const file = input?.files?.[0];
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isMounted) return;
    const validHeader = bytes.byteLength >= SQLITE_MAGIC.length && [...SQLITE_MAGIC].every((ch, i) => bytes[i] === ch.charCodeAt(0));
    if (!validHeader) {
      showAlert('File yang dipilih bukan database SQLite yang valid.', 'danger');
      return;
    }
    const decision = await guardLocalImportWhileSignedIn(file.name);
    if (decision === 'cancel' || !isMounted) return;

    if (decision === 'proceed') {
      const ok = await confirmDialog({
        title: 'Pulihkan Database SQLite?', text: `Database lokal saat ini akan digantikan oleh "${file.name}".`,
        confirmButtonText: 'Ya, Pulihkan', confirmButtonColor: '#d20f39'
      });
      if (!ok || !isMounted) return;
    }

    await db.importDb(bytes);
    if (decision === 'overwrite_drive') {
      await gdrive.saveToDrive({ force: true });
    }
    window.dispatchEvent(new CustomEvent('kasin:db-updated'));
    showAlert('Database SQLite berhasil dipulihkan.', 'success');
    refreshSyncStatus();
  } catch (err) {
    showAlert(`Gagal memulihkan SQLite: ${err?.message || err}`, 'danger');
  } finally {
    if (input) input.value = '';
  }
}

function buildHtml(clientId) {
  return `
    <div class="container py-3 pb-5">
      <h4 class="fw-bold mb-3 db-title"><i class="fas fa-database me-2"></i>Databases & Sync</h4>
      <div class="card db-card mb-3">
        <div class="card-header bg-transparent border-0 pt-3 px-3 d-flex flex-wrap justify-content-between align-items-center gap-2">
          <h6 class="fw-bold mb-0"><i class="fab fa-google-drive me-2" style="color: var(--green-color);"></i>Google Drive Sync</h6>
          <div>
            <span id="db-drive-status-badge" class="badge text-bg-secondary">Lokal</span>
            <span id="db-drive-pending-badge" class="badge ms-1 d-none" style="background-color: var(--primary-color); color: var(--white-color);">0 pending delta</span>
          </div>
        </div>
        <div class="card-body">
          <div class="small text-muted mb-3">Sinkronisasi terakhir: <span id="db-drive-last-synced" class="fw-semibold text-dark">-</span></div>
          <div class="d-flex flex-wrap gap-2 mb-3">
            <button type="button" id="btn-drive-signin" class="btn db-btn-primary"><i class="fab fa-google me-1"></i>Sign in with Google</button>
            <button type="button" id="btn-drive-sync" class="btn db-btn-success d-none"><i class="fas fa-sync me-1"></i>Sync Sekarang</button>
            <button type="button" id="btn-drive-signout" class="btn btn-outline-secondary d-none"><i class="fas fa-sign-out-alt me-1"></i>Sign out</button>
          </div>
          <details class="db-details p-2">
            <summary class="small fw-semibold user-select-none" style="cursor:pointer">Pengaturan Lanjutan</summary>
            <div class="pt-3">
              <div class="mb-2 small">Mode Penyimpanan: <span id="db-storage-mode" class="badge text-bg-light text-dark border ms-1">-</span></div>
              <label for="db-google-client-id" class="form-label small fw-semibold">Google OAuth Client ID</label>
              <div class="input-group input-group-sm mb-3">
                <input type="text" id="db-google-client-id" class="form-control db-input" placeholder="1234567890-xxxx.apps.googleusercontent.com" value="${escapeHtml(clientId)}">
                <button type="button" id="btn-save-client-id" class="btn db-btn-outline">Simpan</button>
              </div>
              <button type="button" id="btn-drive-compact" class="btn btn-sm db-btn-warning"><i class="fas fa-compress-alt me-1"></i>Compact Snapshot</button>
            </div>
          </details>
        </div>
      </div>

      <div class="card db-card mb-3">
        <div class="card-header bg-transparent border-0 pt-3 px-3"><h6 class="fw-bold mb-0"><i class="fas fa-file-csv me-2" style="color: var(--primary-color);"></i>Ekspor & Impor CSV</h6></div>
        <div class="card-body">
          <div class="row g-2 align-items-end mb-3">
            <div class="col-12 col-md-7">
              <label for="db-csv-date-range" class="form-label small fw-semibold">Rentang Tanggal Ekspor</label>
              <input type="text" id="db-csv-date-range" class="form-control db-input" placeholder="Pilih rentang tanggal..." readonly>
            </div>
            <div class="col-12 col-md-5"><button type="button" id="btn-download-csv" class="btn db-btn-primary w-100"><i class="fas fa-download me-1"></i>Download CSV</button></div>
          </div>
          <label for="db-csv-import-file" class="form-label small fw-semibold">Impor Pembaruan CSV (maks. ${MAX_CSV_IMPORT_ROWS} baris)</label>
          <input type="file" id="db-csv-import-file" class="form-control" accept=".csv,text/csv">
        </div>
      </div>

      <div class="card db-card mb-4">
        <div class="card-header bg-transparent border-0 pt-3 px-3"><h6 class="fw-bold mb-0"><i class="fas fa-hdd me-2" style="color: var(--yellow-color);"></i>Cadangan SQLite & Reinitialize</h6></div>
        <div class="card-body">
          <div class="row g-2 align-items-end mb-3">
            <div class="col-12 col-md-5"><button type="button" id="btn-download-sqlite" class="btn db-btn-outline w-100"><i class="fas fa-file-download me-1"></i>Download SQLite</button></div>
            <div class="col-12 col-md-7">
              <label for="db-sqlite-restore-file" class="form-label small fw-semibold">Restore SQLite (.sqlite / .db)</label>
              <input type="file" id="db-sqlite-restore-file" class="form-control" accept=".sqlite,.db,.sqlite3">
            </div>
          </div>
          ${isFileSystemAccessSupported() ? `
          <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 py-2 border-top">
            <span class="small text-muted">File SQLite Terhubung: <strong id="db-local-file-name" class="text-dark">-</strong></span>
            <div class="d-flex gap-2">
              <button type="button" id="btn-connect-local-sqlite" class="btn db-btn-outline btn-sm"><i class="fas fa-link me-1"></i>Hubungkan File Lokal</button>
              <button type="button" id="btn-disconnect-local-sqlite" class="btn btn-outline-secondary btn-sm d-none"><i class="fas fa-unlink me-1"></i>Putuskan</button>
            </div>
          </div>` : ''}
          <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 pt-2 border-top">
            <span class="small text-muted"><strong style="color: var(--red-color);">Reinitialize:</strong> Ringkas transaksi menjadi Saldo Awal.</span>
            <button type="button" id="btn-reinitialize-sql" class="btn db-btn-danger btn-sm"><i class="fas fa-sync-alt me-1"></i>Reinitialize SQL</button>
          </div>
        </div>
      </div>
    </div>`;
}

export async function mount(container, _params) {
  isMounted = true;
  rootContainer = container;
  if (!document.getElementById(STYLE_ID)) {
    const styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    styleEl.textContent = DATABASES_CSS;
    document.head.appendChild(styleEl);
  }
  const now = new Date();
  currentStartDate = formatDBDate(new Date(now.getFullYear(), now.getMonth(), 1));
  currentEndDate = formatDBDate(now);
  container.innerHTML = buildHtml(getGoogleClientId());

  const rangeEl = $('#db-csv-date-range');
  if (rangeEl && window.flatpickr) {
    datePicker = window.flatpickr(rangeEl, {
      disableMobile: true,
      mode: 'range',
      dateFormat: 'Y-m-d',
      altInput: true,
      altFormat: 'd M Y',
      altInputClass: 'form-control db-input',
      defaultDate: [currentStartDate, currentEndDate],
      onClose(dates) {
        if (dates.length === 2) { currentStartDate = formatDBDate(dates[0]); currentEndDate = formatDBDate(dates[1]); }
      }
    });
  }

  $('#btn-save-client-id')?.addEventListener('click', () => {
    const val = $('#db-google-client-id')?.value.trim() || '';
    setGoogleClientId(val);
    showAlert(val ? 'Google OAuth Client ID disimpan.' : 'Google OAuth Client ID dihapus.', 'success');
    refreshSyncStatus();
  });
  $('#btn-drive-signin')?.addEventListener('click', (e) => runAction(e.currentTarget, async () => {
    const res = await signInGoogleWithProtection();
    if (!isMounted) return;
    if (res?.action === 'cancelled') {
      showAlert('Sinkronisasi Google Drive dibatalkan.', 'info');
    } else if (res?.action === 'uploaded_local') {
      showAlert('Database lokal berhasil diunggah ke Google Drive.', 'success');
    } else {
      showAlert('Masuk & memuat database terbaru dari Google Drive.', 'success');
    }
  }, 'Gagal masuk Google Drive'));
  $('#btn-drive-sync')?.addEventListener('click', (e) => runAction(e.currentTarget, handleDriveSync, 'Gagal sinkronisasi Drive'));
  $('#btn-drive-signout')?.addEventListener('click', () => {
    gdrive.signOut();
    showAlert('Keluar dari Google Drive. Berjalan dalam Mode Lokal.', 'info');
    refreshSyncStatus();
  });
  $('#btn-drive-compact')?.addEventListener('click', (e) => runAction(e.currentTarget, async () => {
    const res = await gdrive.compactSnapshot();
    if (!isMounted) return;
    if (res?.status === 'compacted') showAlert(`Snapshot dipadatkan (${res.deletedDeltas || 0} delta dihapus).`, 'success');
    else if (res?.status === 'saved') showAlert('Database disimpan sebagai snapshot awal.', 'success');
    else if (res?.status === 'offline') showAlert('Tidak dapat memadatkan snapshot saat offline.', 'warning');
    else showAlert('Snapshot sudah terbaru.', 'info');
  }, 'Gagal memadatkan snapshot'));
  $('#btn-download-csv')?.addEventListener('click', (e) => runAction(e.currentTarget, handleDownloadCSV, 'Gagal mengekspor CSV'));
  $('#db-csv-import-file')?.addEventListener('change', handleImportCSV);
  $('#btn-download-sqlite')?.addEventListener('click', (e) => runAction(e.currentTarget, async () => {
    const bytes = await db.exportDb();
    if (!isMounted) return;
    downloadBlob(new Blob([bytes], { type: 'application/x-sqlite3' }), `kasin_backup_${formatStamp()}.sqlite`);
    showAlert('Backup SQLite berhasil diunduh.', 'success');
  }, 'Gagal mengunduh SQLite'));
  $('#db-sqlite-restore-file')?.addEventListener('change', handleRestoreSqlite);
  const refreshLocalFileUi = async () => {
    const nameEl = $('#db-local-file-name');
    const disBtn = $('#btn-disconnect-local-sqlite');
    if (!nameEl) return;
    const info = await getConnectedLocalFile();
    if (!isMounted) return;
    nameEl.textContent = info?.name || 'Tidak ada';
    disBtn?.classList.toggle('d-none', !info);
  };
  $('#btn-connect-local-sqlite')?.addEventListener('click', (e) => runAction(e.currentTarget, async () => {
    const decision = await guardLocalImportWhileSignedIn('file SQLite lokal');
    if (decision === 'cancel' || !isMounted) return;
    const res = await connectLocalSqliteFile();
    if (!isMounted) return;
    if (decision === 'overwrite_drive') {
      await gdrive.saveToDrive({ force: true });
    }
    await refreshLocalFileUi();
    window.dispatchEvent(new CustomEvent('kasin:db-updated'));
    showAlert(`Terhubung langsung ke ${res.name} (auto-save aktif).`, 'success');
  }, 'Gagal menghubungkan file SQLite lokal'));
  $('#btn-disconnect-local-sqlite')?.addEventListener('click', async () => {
    await disconnectLocalFile();
    await refreshLocalFileUi();
    showAlert('Koneksi file SQLite lokal diputuskan.', 'info');
  });
  await refreshLocalFileUi();
  $('#btn-reinitialize-sql')?.addEventListener('click', (e) => runAction(e.currentTarget, async () => {
    const ok = await confirmDialog({
      title: 'Reinitialize Database?',
      text: 'Semua riwayat transaksi akan diringkas menjadi Saldo Awal per rekening. Tindakan ini tidak dapat dibatalkan!',
      confirmButtonText: 'Ya, Reinitialize', confirmButtonColor: '#d20f39'
    });
    if (!ok || !isMounted) return;
    await transaksiModel.reinitialize();
    if (!isMounted) return;
    window.dispatchEvent(new CustomEvent('kasin:db-updated'));
    showAlert('Database berhasil di-reinitialize dengan Saldo Awal terbaru.', 'success');
  }, 'Gagal melakukan reinitialize'));

  dbUpdatedHandler = () => refreshSyncStatus();
  window.addEventListener('kasin:db-updated', dbUpdatedHandler);
  await refreshSyncStatus();
}

export function unmount() {
  isMounted = false;
  if (dbUpdatedHandler) { window.removeEventListener('kasin:db-updated', dbUpdatedHandler); dbUpdatedHandler = null; }
  if (datePicker) { try { datePicker.destroy(); } catch { /* ignore */ } datePicker = null; }
  if (rootContainer) { rootContainer.innerHTML = ''; rootContainer = null; }
}
