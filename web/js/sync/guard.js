import { db } from '../db/client.js';
import { getConnectedLocalFile, disconnectLocalFile } from '../db/local-file.js';
import * as gdrive from './gdrive.js';
import { escapeHtml } from '../utils.js';

export async function getLocalDbStats() {
  const [rekRow, txRow, localFile] = await Promise.all([
    db.queryOne('SELECT COUNT(*) AS cnt FROM REKENING').catch(() => ({ cnt: 0 })),
    db.queryOne('SELECT COUNT(*) AS cnt, MAX(tanggal) AS last_date FROM TRANSAKSI').catch(() => ({ cnt: 0, last_date: null })),
    getConnectedLocalFile()
  ]);

  return {
    rekeningCount: Number(rekRow?.cnt ?? 0),
    txCount: Number(txRow?.cnt ?? 0),
    lastDate: txRow?.last_date || '-',
    localFile
  };
}

/**
 * Local -> Google protection: compares local data vs Google Drive before overwriting either side.
 */
export async function signInGoogleWithProtection() {
  const stats = await getLocalDbStats();
  const { remoteFile } = await gdrive.signIn({ skipPull: true });

  const hasLocalData = stats.rekeningCount > 0 || stats.txCount > 0 || Boolean(stats.localFile);
  if (!hasLocalData) {
    if (remoteFile) {
      await gdrive.pullIfNewer({ force: true });
      return { action: 'pulled_drive' };
    }
    await gdrive.saveToDrive({ force: true });
    return { action: 'uploaded_local' };
  }

  const localSource = stats.localFile ? `File: ${stats.localFile.name}` : 'Browser Lokal';
  const remoteInfo = remoteFile
    ? `Tersedia (${new Date(remoteFile.modifiedTime).toLocaleString('id-ID')}${remoteFile.size ? `, ${(Number(remoteFile.size) / 1024).toFixed(1)} KB` : ''})`
    : 'Belum ada database di Google Drive';

  if (window.Swal?.fire) {
    const res = await window.Swal.fire({
      title: 'Sinkronkan dengan Google Drive?',
      icon: 'question',
      html: `
        <div class="text-start small">
          <div class="p-2 rounded border mb-2 bg-light">
            <strong>Data Lokal (${escapeHtml(localSource)}):</strong><br>
            ${escapeHtml(stats.rekeningCount)} rekening &bull; ${escapeHtml(stats.txCount)} transaksi (Terakhir: ${escapeHtml(stats.lastDate)})
          </div>
          <div class="p-2 rounded border bg-light">
            <strong>Google Drive:</strong><br>
            ${escapeHtml(remoteInfo)}
          </div>
        </div>
      `,
      showDenyButton: Boolean(remoteFile),
      showCancelButton: true,
      confirmButtonText: 'Upload Lokal ke Drive',
      denyButtonText: 'Gunakan Data Drive',
      cancelButtonText: 'Batal'
    });

    if (res.isConfirmed) {
      await gdrive.saveToDrive({ force: true });
      return { action: 'uploaded_local' };
    }
    if (res.isDenied && remoteFile) {
      await disconnectLocalFile();
      await gdrive.pullIfNewer({ force: true });
      return { action: 'pulled_drive' };
    }

    gdrive.signOut();
    return { action: 'cancelled' };
  }

  // Fallback without Swal
  if (remoteFile) {
    const useDrive = window.confirm(
      `Data lokal (${stats.txCount} transaksi) ditemukan.\nOK = Gunakan Data Google Drive (timpa lokal)\nCancel = Batal`
    );
    if (!useDrive) {
      gdrive.signOut();
      return { action: 'cancelled' };
    }
    await disconnectLocalFile();
    await gdrive.pullIfNewer({ force: true });
    return { action: 'pulled_drive' };
  }

  await gdrive.saveToDrive({ force: true });
  return { action: 'uploaded_local' };
}

/**
 * Google -> Local protection: warns before loading/connecting a local SQLite file while signed in to Google Drive.
 * @param {string} incomingLabel
 * @returns {Promise<'proceed' | 'disconnect' | 'overwrite_drive' | 'cancel'>}
 */
export async function guardLocalImportWhileSignedIn(incomingLabel = 'file SQLite lokal') {
  if (!gdrive.isSignedIn()) return 'proceed';

  const [stats, profile] = await Promise.all([
    getLocalDbStats(),
    Promise.resolve(gdrive.getUserProfile())
  ]);
  const accountLabel = profile?.email || profile?.name || 'Google Drive';

  if (window.Swal?.fire) {
    const res = await window.Swal.fire({
      title: 'Sedang Terhubung ke Google Drive',
      icon: 'warning',
      html: `
        <div class="text-start small">
          <p class="mb-2">Anda sedang masuk sebagai <strong>${escapeHtml(accountLabel)}</strong> (${escapeHtml(stats.rekeningCount)} rekening, ${escapeHtml(stats.txCount)} transaksi).</p>
          <p class="mb-0">Anda akan memuat <strong>${escapeHtml(incomingLabel)}</strong>. Pilih tindakan agar data Google Drive tidak tertimpa tanpa sengaja:</p>
        </div>
      `,
      showDenyButton: true,
      showCancelButton: true,
      confirmButtonText: 'Pindah ke Lokal & Putuskan Drive',
      denyButtonText: 'Muat Lokal & Timpa Drive',
      cancelButtonText: 'Batal',
      denyButtonColor: '#d20f39'
    });

    if (res.isConfirmed) {
      gdrive.signOut();
      return 'disconnect';
    }
    if (res.isDenied) {
      return 'overwrite_drive';
    }
    return 'cancel';
  }

  const ok = window.confirm(
    `Anda sedang terhubung ke Google Drive (${accountLabel}).\nPutuskan Google Drive agar file di Drive aman sebelum memuat "${incomingLabel}"?`
  );
  if (!ok) return 'cancel';
  gdrive.signOut();
  return 'disconnect';
}
