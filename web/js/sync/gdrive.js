import { db, saveAttachment, readAttachment } from '../db/client.js';
import { GOOGLE_DRIVE_SCOPE, getGoogleClientId } from '../config.js';

const DRIVE_DB_FILENAME = 'kasin.sqlite';
const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

const STORAGE_KEY_SNAPSHOT_TIME = 'kasin_drive_snapshot_time';
const STORAGE_KEY_MODIFIED_TIME_LEGACY = 'kasin_drive_modified_time';
const STORAGE_KEY_FILE_ID = 'kasin_drive_file_id';
const STORAGE_KEY_DIRTY = 'kasin_drive_dirty';
const STORAGE_KEY_APPLIED_DELTAS = 'kasin_applied_deltas';
const STORAGE_KEY_PENDING_DELTAS = 'kasin_pending_deltas';
const STORAGE_KEY_USER_PROFILE = 'kasin_google_profile';
const SESSION_KEY_TOKEN = 'kasin_drive_access_token';
const SESSION_KEY_EXPIRES_AT = 'kasin_drive_token_expires_at';

const COMPACT_THRESHOLD = 50;
const AUTO_SAVE_DEBOUNCE_MS = 800;
const TOKEN_REFRESH_BUFFER_MS = 15000;
const FULL_SNAPSHOT_DELETE_RE = /DELETE\s+FROM\s+TRANSAKSI/i;

let accessToken = null;
let tokenExpiresAt = 0;

function loadSessionToken() {
  try {
    const savedToken = sessionStorage.getItem(SESSION_KEY_TOKEN);
    const savedExpiresAt = Number(sessionStorage.getItem(SESSION_KEY_EXPIRES_AT));
    if (savedToken && Number.isFinite(savedExpiresAt) && Date.now() < savedExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
      accessToken = savedToken;
      tokenExpiresAt = savedExpiresAt;
    } else if (savedToken || savedExpiresAt) {
      sessionStorage.removeItem(SESSION_KEY_TOKEN);
      sessionStorage.removeItem(SESSION_KEY_EXPIRES_AT);
    }
  } catch {
    // Ignore sessionStorage errors in restricted environments
  }
}

function saveSessionToken(token, expiresAt) {
  accessToken = token;
  tokenExpiresAt = expiresAt;
  try {
    sessionStorage.setItem(SESSION_KEY_TOKEN, token);
    sessionStorage.setItem(SESSION_KEY_EXPIRES_AT, String(expiresAt));
  } catch {
    // Ignore sessionStorage errors in restricted environments
  }
}

function clearSessionToken() {
  accessToken = null;
  tokenExpiresAt = 0;
  try {
    sessionStorage.removeItem(SESSION_KEY_TOKEN);
    sessionStorage.removeItem(SESSION_KEY_EXPIRES_AT);
  } catch {
    // Ignore sessionStorage errors in restricted environments
  }
}

loadSessionToken();
let isPulling = false;
let autoSaveUnsubscribe = null;
let autoSaveTimer = null;
let autoSaveListenersBound = false;
let syncQueue = Promise.resolve();

function runSerializedSync(task) {
  const next = syncQueue.then(task, task);
  syncQueue = next.catch(() => {});
  return next;
}

function getStorageItem(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setStorageItem(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}

function removeStorageItem(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}

function getSnapshotTime() {
  return getStorageItem(STORAGE_KEY_SNAPSHOT_TIME) || getStorageItem(STORAGE_KEY_MODIFIED_TIME_LEGACY);
}

function setSnapshotTime(modifiedTime) {
  setStorageItem(STORAGE_KEY_SNAPSHOT_TIME, modifiedTime);
  removeStorageItem(STORAGE_KEY_MODIFIED_TIME_LEGACY);
}

function getAppliedDeltas() {
  const raw = getStorageItem(STORAGE_KEY_APPLIED_DELTAS);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
  } catch {
    return new Set();
  }
}

function saveAppliedDeltas(set) {
  setStorageItem(STORAGE_KEY_APPLIED_DELTAS, JSON.stringify(Array.from(set)));
}

function addAppliedDelta(id) {
  if (!id) return;
  const set = getAppliedDeltas();
  set.add(String(id));
  saveAppliedDeltas(set);
}

function clearAppliedDeltas() {
  removeStorageItem(STORAGE_KEY_APPLIED_DELTAS);
}

function getPendingDeltas() {
  const raw = getStorageItem(STORAGE_KEY_PENDING_DELTAS);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function setPendingDeltas(ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    removeStorageItem(STORAGE_KEY_PENDING_DELTAS);
    return;
  }
  setStorageItem(STORAGE_KEY_PENDING_DELTAS, JSON.stringify(ops));
}

function clearPendingDeltas() {
  removeStorageItem(STORAGE_KEY_PENDING_DELTAS);
}

function appendOpsToPending(batchOps) {
  if (!Array.isArray(batchOps) || batchOps.length === 0) return;
  const pending = getPendingDeltas();
  const offset = pending.length;

  for (const op of batchOps) {
    if (!op || typeof op.sql !== 'string') continue;
    const normalized = {
      sql: op.sql,
      bind: Array.isArray(op.bind) ? op.bind : []
    };
    if (Number.isInteger(op.relasiRefIndex) && Number.isInteger(op.relasiParamIndex)) {
      normalized.relasiRefIndex = op.relasiRefIndex + offset;
      normalized.relasiParamIndex = op.relasiParamIndex;
    }
    pending.push(normalized);
  }

  setPendingDeltas(pending);
}

function formatUtcCompactTimestamp(date = new Date()) {
  const pad2 = (n) => String(n).padStart(2, '0');
  const pad3 = (n) => String(n).padStart(3, '0');
  return (
    `${date.getUTCFullYear()}` +
    `${pad2(date.getUTCMonth() + 1)}` +
    `${pad2(date.getUTCDate())}T` +
    `${pad2(date.getUTCHours())}` +
    `${pad2(date.getUTCMinutes())}` +
    `${pad2(date.getUTCSeconds())}` +
    `${pad3(date.getUTCMilliseconds())}Z`
  );
}

function randomHex4() {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const arr = new Uint16Array(1);
    crypto.getRandomValues(arr);
    return arr[0].toString(16).padStart(4, '0');
  }
  return Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
}

function extractDeltaIdFromName(name) {
  if (typeof name !== 'string') return null;
  const match = /^delta_(.+)\.json$/.exec(name);
  return match ? match[1] : null;
}

function isStrictlyOlderTime(aIso, bIso) {
  if (!aIso || !bIso) return false;
  const aMs = Date.parse(aIso);
  const bMs = Date.parse(bIso);
  if (Number.isFinite(aMs) && Number.isFinite(bMs)) {
    return aMs < bMs;
  }
  return aIso < bIso;
}

function isValidDeltaPayload(delta) {
  if (!delta || !Array.isArray(delta.ops)) {
    return false;
  }
  return delta.ops.every(
    (op) => op && typeof op.sql === 'string' && Array.isArray(op.bind)
  );
}

function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function updateStatus(text, variant = 'secondary') {
  if (typeof window !== 'undefined') {
    window.KasInApp?.setDriveStatus?.(text, variant);
  }
}

function buildMultipartBody({ fileId = null, name, mimeType, blobOrBytes }) {
  const randomSuffix =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const boundary = `kasin_${randomSuffix}`;
  const metadata = fileId
    ? { name, mimeType }
    : { name, mimeType, parents: ['appDataFolder'] };

  const headerPart =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;
  const footerPart = `\r\n--${boundary}--`;

  const payload =
    blobOrBytes instanceof Blob
      ? blobOrBytes
      : new Blob([blobOrBytes], { type: mimeType });

  const body = new Blob([headerPart, payload, footerPart], {
    type: `multipart/related; boundary=${boundary}`
  });

  return { boundary, body };
}

async function authFetch(url, options = {}) {
  if (!isSignedIn()) {
    throw new Error('Belum masuk ke Google Drive.');
  }

  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${accessToken}`);

  const response = await fetch(url, {
    ...options,
    headers
  });

  if (response.status === 401) {
    clearSessionToken();
    updateStatus('Local Mode', 'secondary');
  }

  if (!response.ok) {
    let detail = '';
    try {
      const text = await response.text();
      detail = text ? `: ${text}` : '';
    } catch {
      detail = '';
    }
    throw new Error(`Google Drive API error (${response.status})${detail}`);
  }

  return response;
}

async function deleteDriveFile(fileId) {
  await authFetch(`${DRIVE_FILES_API}/${encodeURIComponent(fileId)}`, {
    method: 'DELETE'
  });
}

/**
 * Check whether a Google OAuth Client ID is configured.
 * @returns {boolean}
 */
export function isConfigured() {
  return Boolean(getGoogleClientId());
}

/**
 * Check whether a valid, non-expired Google OAuth access token is present in memory.
 * @returns {boolean}
 */
export function isSignedIn() {
  return Boolean(accessToken) && Date.now() < tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS;
}

export function getUserProfile() {
  const raw = getStorageItem(STORAGE_KEY_USER_PROFILE);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function fetchUserProfile() {
  if (!accessToken) return null;
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const profile = {
      name: data?.name || '',
      email: data?.email || '',
      picture: data?.picture || ''
    };
    setStorageItem(STORAGE_KEY_USER_PROFILE, JSON.stringify(profile));
    return profile;
  } catch {
    return null;
  }
}

/**
 * Initiate Google Identity Services OAuth2 token flow and optionally pull Drive SSOT.
 * @param {{ prompt?: string, skipPull?: boolean }} [options]
 * @returns {Promise<object>}
 */
export function signIn({ prompt = '', skipPull = false } = {}) {
  const clientId = getGoogleClientId();
  if (!clientId) {
    return Promise.reject(new Error('Google Client ID belum dikonfigurasi.'));
  }

  const oauth2 = typeof google !== 'undefined' ? google?.accounts?.oauth2 : null;
  if (!oauth2?.initTokenClient) {
    return Promise.reject(new Error('Google Identity Services belum dimuat.'));
  }

  return new Promise((resolve, reject) => {
    const tokenClient = oauth2.initTokenClient({
      client_id: clientId,
      scope: GOOGLE_DRIVE_SCOPE,
      callback: async (response) => {
        if (!response || response.error || !response.access_token) {
          const message =
            response?.error_description ||
            response?.error ||
            'Gagal mendapatkan token akses Google Drive.';
          reject(new Error(message));
          return;
        }

        const expiresInSec = Number(response.expires_in) || 3600;
        saveSessionToken(response.access_token, Date.now() + expiresInSec * 1000);
        updateStatus('Syncing...', 'info');

        await fetchUserProfile();

        try {
          if (skipPull) {
            const remoteFile = await findFile(DRIVE_DB_FILENAME);
            resolve({ signedIn: true, remoteFile });
            return;
          }
          const syncResult = await pullIfNewer();
          resolve(syncResult);
        } catch (err) {
          reject(err);
        }
      },
      error_callback: (err) => {
        const message = err?.message || err?.type || 'Google Sign-In dibatalkan.';
        reject(new Error(message));
      }
    });

    const requestOptions = { prompt };
    const savedProfile = getUserProfile();
    if (savedProfile?.email && prompt !== 'select_account') {
      requestOptions.hint = savedProfile.email;
    }
    tokenClient.requestAccessToken(requestOptions);
  });
}

/**
 * Revoke the active Google OAuth token (if available) and return to Local Mode.
 */
export function signOut() {
  const tokenToRevoke = accessToken;
  clearSessionToken();
  removeStorageItem(STORAGE_KEY_USER_PROFILE);

  if (tokenToRevoke && typeof google !== 'undefined' && google?.accounts?.oauth2?.revoke) {
    try {
      google.accounts.oauth2.revoke(tokenToRevoke, () => {});
    } catch {
      // Ignore revoke errors on sign-out
    }
  }

  updateStatus('Local Mode', 'secondary');
}

/**
 * Find a file by exact name inside Google Drive appDataFolder.
 * @param {string} name
 * @returns {Promise<{ id: string, name: string, modifiedTime: string, md5Checksum?: string, size?: string } | null>}
 */
export async function findFile(name) {
  const escapedName = String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const query = `name = '${escapedName}' and trashed = false`;
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    q: query,
    fields: 'files(id,name,modifiedTime,md5Checksum,size)',
    pageSize: '1'
  });

  const response = await authFetch(`${DRIVE_FILES_API}?${params.toString()}`);
  const data = await response.json();
  return data.files?.[0] || null;
}

/**
 * List all delta_*.json files in Google Drive appDataFolder ordered by name ascending.
 * @returns {Promise<Array<{ id: string, name: string, modifiedTime: string, size?: string }>>}
 */
export async function listDeltaFiles() {
  const files = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      q: "name contains 'delta_' and trashed = false",
      orderBy: 'name asc',
      fields: 'nextPageToken,files(id,name,modifiedTime,size)',
      pageSize: '1000'
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const response = await authFetch(`${DRIVE_FILES_API}?${params.toString()}`);
    const data = await response.json();
    for (const file of data.files || []) {
      if (file?.name?.startsWith('delta_') && file.name.endsWith('.json')) {
        files.push(file);
      }
    }
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return files;
}

/**
 * Create or update a file in Google Drive appDataFolder using multipart upload.
 * @param {{ fileId?: string | null, name: string, mimeType?: string, blobOrBytes: Blob | Uint8Array | ArrayBuffer }} options
 * @returns {Promise<{ id: string, modifiedTime: string, md5Checksum?: string }>}
 */
export async function uploadMultipart({
  fileId = null,
  name,
  mimeType = 'application/octet-stream',
  blobOrBytes
}) {
  const { boundary, body } = buildMultipartBody({
    fileId,
    name,
    mimeType,
    blobOrBytes
  });

  const baseUrl = fileId
    ? `${DRIVE_UPLOAD_API}/${encodeURIComponent(fileId)}`
    : DRIVE_UPLOAD_API;
  const method = fileId ? 'PATCH' : 'POST';
  const url = `${baseUrl}?uploadType=multipart&fields=id,modifiedTime,md5Checksum`;

  const response = await authFetch(url, {
    method,
    headers: {
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body
  });

  return response.json();
}

/**
 * Upload a JSON delta file (delta_<YYYYMMDDTHHMMSSmmmZ>_<4hex>.json) to Google Drive appDataFolder.
 * @param {Array<{ sql: string, bind: Array, relasiRefIndex?: number, relasiParamIndex?: number }>} ops
 * @returns {Promise<{ id: string, filename: string, uploaded: object }>}
 */
export async function uploadDelta(ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new Error('uploadDelta(ops) requires a non-empty array of operations.');
  }

  const now = new Date();
  const id = `${formatUtcCompactTimestamp(now)}_${randomHex4()}`;
  const filename = `delta_${id}.json`;
  const payload = {
    v: 1,
    id,
    ts: now.toISOString(),
    ops
  };

  const uploaded = await uploadMultipart({
    name: filename,
    mimeType: 'application/json',
    blobOrBytes: new Blob([JSON.stringify(payload)], { type: 'application/json' })
  });

  return { id, filename, uploaded };
}

/**
 * Download raw file bytes from Google Drive appDataFolder.
 * @param {string} fileId
 * @returns {Promise<Uint8Array>}
 */
export async function downloadFileBytes(fileId) {
  const url = `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}?alt=media`;
  const response = await authFetch(url);
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Pull kasin.sqlite snapshot and unseen delta_*.json files from Google Drive,
 * or initialize Drive from local DB if Drive has neither snapshot nor deltas.
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<object>}
 */
export async function pullIfNewer({ force = false } = {}) {
  if (!isSignedIn()) {
    return { status: 'unauthenticated' };
  }
  if (!isOnline()) {
    updateStatus('Offline', 'warning');
    return { status: 'offline' };
  }

  const [remoteSnapshot, deltaFiles] = await Promise.all([
    findFile(DRIVE_DB_FILENAME),
    listDeltaFiles()
  ]);

  if (!remoteSnapshot && deltaFiles.length === 0) {
    return saveToDrive({ force: true });
  }

  let importedSnapshot = false;
  const lastKnownSnapshotTime = getSnapshotTime();

  if (remoteSnapshot && (force || remoteSnapshot.modifiedTime !== lastKnownSnapshotTime)) {
    updateStatus('Syncing...', 'info');
    const bytes = await downloadFileBytes(remoteSnapshot.id);

    isPulling = true;
    try {
      await db.importDb(bytes);
    } finally {
      isPulling = false;
    }

    setSnapshotTime(remoteSnapshot.modifiedTime);
    setStorageItem(STORAGE_KEY_FILE_ID, remoteSnapshot.id);
    clearAppliedDeltas();
    importedSnapshot = true;
  } else if (remoteSnapshot) {
    setStorageItem(STORAGE_KEY_FILE_ID, remoteSnapshot.id);
  }

  const appliedSet = getAppliedDeltas();
  let appliedDeltas = 0;

  for (const file of deltaFiles) {
    const deltaId = extractDeltaIdFromName(file.name);
    if (!deltaId || appliedSet.has(deltaId)) {
      continue;
    }
    if (
      importedSnapshot &&
      remoteSnapshot?.modifiedTime &&
      isStrictlyOlderTime(file.modifiedTime, remoteSnapshot.modifiedTime)
    ) {
      continue;
    }

    updateStatus('Syncing...', 'info');
    const bytes = await downloadFileBytes(file.id);
    const delta = JSON.parse(new TextDecoder().decode(bytes));

    if (!isValidDeltaPayload(delta)) {
      throw new Error(`Format delta tidak valid pada ${file.name}`);
    }

    if (delta.ops.length > 0) {
      isPulling = true;
      try {
        await db.transaction(delta.ops);
      } finally {
        isPulling = false;
      }
    }

    const recordedId = delta.id ? String(delta.id) : deltaId;
    appliedSet.add(recordedId);
    appliedSet.add(deltaId);
    saveAppliedDeltas(appliedSet);
    appliedDeltas += 1;
  }

  if (importedSnapshot || appliedDeltas > 0) {
    if (getPendingDeltas().length === 0) {
      removeStorageItem(STORAGE_KEY_DIRTY);
    }
    updateStatus('Saved to Drive ✓', 'success');

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kasin:db-updated'));
    }

    return {
      status: 'pulled',
      modifiedTime: remoteSnapshot?.modifiedTime || null,
      fileId: remoteSnapshot?.id || null,
      importedSnapshot,
      appliedDeltas
    };
  }

  updateStatus('Saved to Drive ✓', 'success');
  return {
    status: 'up-to-date',
    modifiedTime: remoteSnapshot?.modifiedTime || null,
    fileId: remoteSnapshot?.id || null,
    importedSnapshot: false,
    appliedDeltas: 0
  };
}

/**
 * Save local SQLite database to Google Drive appDataFolder with conflict detection.
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<object>}
 */
export async function saveToDrive({ force = false } = {}) {
  if (!isOnline()) {
    setStorageItem(STORAGE_KEY_DIRTY, '1');
    updateStatus('Offline (Pending)', 'warning');
    return { status: 'offline' };
  }

  if (!isSignedIn()) {
    return { status: 'unauthenticated' };
  }

  updateStatus('Syncing...', 'info');

  const remote = await findFile(DRIVE_DB_FILENAME);
  const lastKnownSnapshotTime = getSnapshotTime();

  if (remote && remote.modifiedTime !== lastKnownSnapshotTime && !force) {
    updateStatus('Sync Conflict', 'danger');
    return {
      status: 'conflict',
      remoteModifiedTime: remote.modifiedTime,
      localModifiedTime: lastKnownSnapshotTime
    };
  }

  const bytes = await db.exportDb();
  const targetFileId = remote?.id || getStorageItem(STORAGE_KEY_FILE_ID) || null;
  const uploaded = await uploadMultipart({
    fileId: targetFileId,
    name: DRIVE_DB_FILENAME,
    mimeType: 'application/x-sqlite3',
    blobOrBytes: bytes
  });

  setStorageItem(STORAGE_KEY_FILE_ID, uploaded.id);
  setSnapshotTime(uploaded.modifiedTime);
  clearPendingDeltas();
  removeStorageItem(STORAGE_KEY_DIRTY);
  updateStatus('Saved to Drive ✓', 'success');

  return {
    status: 'saved',
    modifiedTime: uploaded.modifiedTime,
    fileId: uploaded.id
  };
}

/**
 * Compact remote delta_*.json files into a fresh kasin.sqlite snapshot on Google Drive.
 * @returns {Promise<object>}
 */
export function compactSnapshot() {
  return runSerializedSync(async () => {
    if (!isOnline()) {
      setStorageItem(STORAGE_KEY_DIRTY, '1');
      updateStatus('Offline (Pending)', 'warning');
      return { status: 'offline' };
    }

    if (!isSignedIn()) {
      return { status: 'unauthenticated' };
    }

    updateStatus('Syncing...', 'info');

    await pullIfNewer();

    const deltasToDelete = await listDeltaFiles();
    const remoteSnapshot = await findFile(DRIVE_DB_FILENAME);
    const bytes = await db.exportDb();
    const targetFileId = remoteSnapshot?.id || getStorageItem(STORAGE_KEY_FILE_ID) || null;

    const uploaded = await uploadMultipart({
      fileId: targetFileId,
      name: DRIVE_DB_FILENAME,
      mimeType: 'application/x-sqlite3',
      blobOrBytes: bytes
    });

    await Promise.all(
      deltasToDelete.map((file) => deleteDriveFile(file.id).catch(() => {}))
    );

    setStorageItem(STORAGE_KEY_FILE_ID, uploaded.id);
    setSnapshotTime(uploaded.modifiedTime);
    clearAppliedDeltas();
    clearPendingDeltas();
    removeStorageItem(STORAGE_KEY_DIRTY);
    updateStatus('Saved to Drive ✓', 'success');

    return {
      status: 'compacted',
      modifiedTime: uploaded.modifiedTime,
      fileId: uploaded.id,
      deletedDeltas: deltasToDelete.length
    };
  });
}

async function flushPendingDeltas() {
  return runSerializedSync(async () => {
    if (!isOnline()) {
      updateStatus('Offline (Pending)', 'warning');
      return { status: 'offline' };
    }

    if (!isSignedIn()) {
      return { status: 'unauthenticated' };
    }

    const pending = getPendingDeltas();
    if (pending.length === 0) {
      if (getStorageItem(STORAGE_KEY_DIRTY) === '1') {
        return null;
      }
      return { status: 'empty' };
    }

    updateStatus('Syncing...', 'info');
    const { id } = await uploadDelta(pending);
    addAppliedDelta(id);
    clearPendingDeltas();
    removeStorageItem(STORAGE_KEY_DIRTY);
    updateStatus('Saved to Drive ✓', 'success');

    const remoteDeltas = await listDeltaFiles();
    if (remoteDeltas.length >= COMPACT_THRESHOLD) {
      return { status: 'needs-compact', deltaId: id, remoteDeltaCount: remoteDeltas.length };
    }

    return { status: 'flushed', deltaId: id, remoteDeltaCount: remoteDeltas.length };
  }).then(async (res) => {
    if (res?.status === 'needs-compact' || (res === null && getStorageItem(STORAGE_KEY_DIRTY) === '1')) {
      return compactSnapshot();
    }
    return res;
  });
}

function requiresFullSnapshot(event) {
  if (event?.type === 'importDb') {
    return true;
  }
  const ops = Array.isArray(event?.ops) ? event.ops : [];
  return ops.some((op) => FULL_SNAPSHOT_DELETE_RE.test(op?.sql || ''));
}

/**
 * Subscribe to database writes for debounced delta auto-save and online/offline sync handling.
 */
export function enableAutoSave() {
  if (!autoSaveUnsubscribe) {
    autoSaveUnsubscribe = db.onWrite((event) => {
      if (isPulling) return;

      if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
      }

      if (requiresFullSnapshot(event)) {
        setStorageItem(STORAGE_KEY_DIRTY, '1');

        if (!isOnline()) {
          updateStatus('Offline (Pending)', 'warning');
          return;
        }
        if (!isSignedIn()) {
          return;
        }

        compactSnapshot().catch(() => {
          if (!isOnline()) {
            updateStatus('Offline (Pending)', 'warning');
          }
        });
        return;
      }

      appendOpsToPending(event?.ops || []);
      setStorageItem(STORAGE_KEY_DIRTY, '1');

      if (!isOnline()) {
        updateStatus('Offline (Pending)', 'warning');
        return;
      }

      if (!isSignedIn()) {
        return;
      }

      updateStatus('Syncing...', 'info');
      autoSaveTimer = setTimeout(() => {
        autoSaveTimer = null;
        flushPendingDeltas().catch(() => {
          if (!isOnline()) {
            updateStatus('Offline (Pending)', 'warning');
          }
        });
      }, AUTO_SAVE_DEBOUNCE_MS);
    });
  }

  if (!autoSaveListenersBound && typeof window !== 'undefined') {
    autoSaveListenersBound = true;

    window.addEventListener('online', async () => {
      if (!isSignedIn()) return;

      updateStatus('Syncing...', 'info');
      try {
        await flushPendingDeltas();
        await pullIfNewer();
      } catch {
        if (!isOnline()) {
          updateStatus('Offline (Pending)', 'warning');
        }
      }
    });

    window.addEventListener('offline', () => {
      updateStatus('Offline', 'warning');
    });
  }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((result) => resolve(result || null), type, quality);
  });
}

async function decodeImageSource(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => bitmap.close?.()
      };
    } catch {
      // Fall back to HTMLImageElement decoding below
    }
  }

  if (typeof Image === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    return null;
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to decode image'));
      el.src = objectUrl;
    });
    return {
      source: img,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      cleanup: () => URL.revokeObjectURL(objectUrl)
    };
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    throw err;
  }
}

/**
 * Compress and optionally downscale an image Blob via canvas (WebP with JPEG fallback).
 * Skips SVG and GIF images and keeps the original if compression does not reduce size.
 * @param {Blob} blob
 * @param {number} [maxDim=1600]
 * @param {number} [quality=0.8]
 * @returns {Promise<{ blob: Blob, ext: string | null }>}
 */
export async function compressImageBlob(blob, maxDim = 1600, quality = 0.8) {
  if (!(blob instanceof Blob)) {
    return { blob, ext: null };
  }

  const mime = String(blob.type || '').toLowerCase();
  if (mime === 'image/svg+xml' || mime === 'image/gif') {
    return { blob, ext: null };
  }

  if (typeof document === 'undefined') {
    return { blob, ext: null };
  }

  let decoded = null;
  try {
    decoded = await decodeImageSource(blob);
    if (!decoded || decoded.width <= 0 || decoded.height <= 0) {
      return { blob, ext: null };
    }

    const largest = Math.max(decoded.width, decoded.height);
    const scale = largest > maxDim ? maxDim / largest : 1;
    const targetWidth = Math.max(1, Math.round(decoded.width * scale));
    const targetHeight = Math.max(1, Math.round(decoded.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return { blob, ext: null };
    }
    ctx.drawImage(decoded.source, 0, 0, targetWidth, targetHeight);

    let compressed = await canvasToBlob(canvas, 'image/webp', quality);
    let ext = '.webp';
    if (!compressed || compressed.type !== 'image/webp') {
      compressed = await canvasToBlob(canvas, 'image/jpeg', quality);
      ext = '.jpg';
    }

    if (!compressed || compressed.size >= blob.size) {
      return { blob, ext: null };
    }

    return { blob: compressed, ext };
  } catch {
    return { blob, ext: null };
  } finally {
    decoded?.cleanup?.();
  }
}

/**
 * Gzip-compress a PDF Blob using CompressionStream if available and smaller than original.
 * @param {Blob} blob
 * @returns {Promise<{ blob: Blob, gzipped: boolean }>}
 */
export async function compressPdfBlob(blob) {
  if (!(blob instanceof Blob) || typeof CompressionStream === 'undefined') {
    return { blob, gzipped: false };
  }

  try {
    const gzStream = blob.stream().pipeThrough(new CompressionStream('gzip'));
    const gzBlob = await new Response(gzStream).blob();
    if (gzBlob.size < blob.size) {
      return { blob: gzBlob, gzipped: true };
    }
    return { blob, gzipped: false };
  } catch {
    return { blob, gzipped: false };
  }
}

/**
 * Decompress a Blob if it starts with the gzip magic bytes (0x1f, 0x8b).
 * @param {Blob} blob
 * @param {string} filename
 * @returns {Promise<Blob>}
 */
export async function decompressIfGzipped(blob, filename) {
  if (!(blob instanceof Blob) || blob.size < 2 || typeof DecompressionStream === 'undefined') {
    return blob;
  }

  try {
    const header = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    if (header[0] !== 0x1f || header[1] !== 0x8b) {
      return blob;
    }

    const decompressedStream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
    const decompressedBuffer = await new Response(decompressedStream).arrayBuffer();
    const baseName = String(filename || '').replace(/\.gz$/i, '').toLowerCase();
    const type = baseName.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
    return new Blob([decompressedBuffer], { type });
  } catch {
    return blob;
  }
}

/**
 * Compress (when beneficial), save locally, and upload an attachment to Google Drive appDataFolder.
 * @param {string} filename
 * @param {Blob|File} blob
 * @returns {Promise<string>}
 */
export async function uploadAttachment(filename, blob) {
  let finalFilename = filename;
  let finalBlob = blob;

  const mimeType = String(blob?.type || '').toLowerCase();
  if (mimeType.startsWith('image/')) {
    const { blob: compressedBlob, ext } = await compressImageBlob(blob);
    if (ext) {
      finalBlob = compressedBlob;
      finalFilename = /\.[^.]+$/.test(finalFilename)
        ? finalFilename.replace(/\.[^.]+$/, ext)
        : `${finalFilename}${ext}`;
    }
  } else if (mimeType === 'application/pdf' || String(finalFilename).toLowerCase().endsWith('.pdf')) {
    const { blob: pdfBlob, gzipped } = await compressPdfBlob(blob);
    if (gzipped) {
      finalBlob = pdfBlob;
      if (!String(finalFilename).toLowerCase().endsWith('.gz')) {
        finalFilename = `${finalFilename}.gz`;
      }
    }
  }

  const savedName = await saveAttachment(finalFilename, finalBlob);

  if (isSignedIn() && isOnline()) {
    const driveName = `att_${savedName}`;
    const uploadMimeType = savedName.toLowerCase().endsWith('.gz')
      ? 'application/gzip'
      : (finalBlob?.type || 'application/octet-stream');
    try {
      const existing = await findFile(driveName);
      await uploadMultipart({
        fileId: existing?.id || null,
        name: driveName,
        mimeType: uploadMimeType,
        blobOrBytes: finalBlob
      });
    } catch {
      // Local OPFS/IDB save already succeeded; Drive upload failure is non-fatal
    }
  }

  return savedName;
}

/**
 * Read an attachment from local OPFS/IDB cache, falling back to Google Drive appDataFolder.
 * Transparently decompresses gzip-compressed attachments before returning.
 * @param {string} filename
 * @returns {Promise<Blob | null>}
 */
export async function downloadAttachment(filename) {
  const cached = await readAttachment(filename);
  if (cached) {
    return decompressIfGzipped(cached, filename);
  }

  if (!isSignedIn() || !isOnline()) {
    return null;
  }

  const remote = await findFile(`att_${filename}`);
  if (!remote) {
    return null;
  }

  const bytes = await downloadFileBytes(remote.id);
  const blob = new Blob([bytes]);
  await saveAttachment(filename, blob);
  return decompressIfGzipped(blob, filename);
}

/**
 * Return current Google Drive sync status metadata.
 * @returns {{ configured: boolean, signedIn: boolean, dirty: boolean, lastSyncedAt: string | null, fileId: string | null, pendingDeltas: number }}
 */
export function getSyncState() {
  return {
    configured: isConfigured(),
    signedIn: isSignedIn(),
    dirty: getStorageItem(STORAGE_KEY_DIRTY) === '1',
    lastSyncedAt: getSnapshotTime() || null,
    fileId: getStorageItem(STORAGE_KEY_FILE_ID) || null,
    pendingDeltas: getPendingDeltas().length
  };
}
