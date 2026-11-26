import { db } from './client.js';

const HANDLE_IDB_NAME = 'kasin-local-handle';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'active-sqlite';

let autoSaveUnsubscribe = null;
let saveDebounceTimer = null;

export function isFileSystemAccessSupported() {
  return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';
}

export function isSaveFilePickerSupported() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}

function openHandleIdb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(HANDLE_IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const idb = req.result;
      if (!idb.objectStoreNames.contains(HANDLE_STORE)) {
        idb.createObjectStore(HANDLE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open handle IDB'));
  });
}

async function readStoredHandle() {
  const idb = await openHandleIdb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = idb.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get(HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('Failed to read file handle'));
    });
  } finally {
    idb.close();
  }
}

async function writeStoredHandle(handle) {
  const idb = await openHandleIdb();
  try {
    await new Promise((resolve, reject) => {
      const tx = idb.transaction(HANDLE_STORE, 'readwrite');
      const store = tx.objectStore(HANDLE_STORE);
      const req = handle ? store.put(handle, HANDLE_KEY) : store.delete(HANDLE_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error('Failed to store file handle'));
    });
  } finally {
    idb.close();
  }
}

export async function getConnectedLocalFile() {
  try {
    const handle = await readStoredHandle();
    if (!handle) return null;
    return { name: handle.name || 'local.sqlite', handle };
  } catch {
    return null;
  }
}

export async function disconnectLocalFile() {
  await writeStoredHandle(null);
}

export async function connectLocalSqliteFile() {
  if (!isFileSystemAccessSupported()) {
    throw new Error('Browser tidak mendukung File System Access API.');
  }

  const [handle] = await window.showOpenFilePicker({
    multiple: false,
    types: [
      {
        description: 'SQLite Database',
        accept: {
          'application/x-sqlite3': ['.sqlite', '.sqlite3', '.db']
        }
      }
    ]
  });

  if (!handle) {
    throw new Error('Pemilihan file dibatalkan.');
  }

  let perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') {
    perm = await handle.requestPermission({ mode: 'readwrite' });
  }
  if (perm !== 'granted') {
    throw new Error('Izin tulis ke file SQLite lokal ditolak.');
  }

  const file = await handle.getFile();
  const bytes = new Uint8Array(await file.arrayBuffer());
  await db.importDb(bytes);
  await writeStoredHandle(handle);

  return { name: handle.name || file.name };
}

export async function createLocalSqliteFile(suggestedName = 'kasin.sqlite') {
  if (!isSaveFilePickerSupported()) {
    throw new Error('Browser tidak mendukung pembuatan file lokal langsung.');
  }

  const handle = await window.showSaveFilePicker({
    suggestedName,
    types: [
      {
        description: 'SQLite Database',
        accept: {
          'application/x-sqlite3': ['.sqlite', '.sqlite3', '.db']
        }
      }
    ]
  });

  if (!handle) {
    throw new Error('Pembuatan file dibatalkan.');
  }

  let perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') {
    perm = await handle.requestPermission({ mode: 'readwrite' });
  }
  if (perm !== 'granted') {
    throw new Error('Izin tulis ke file SQLite lokal ditolak.');
  }

  const bytes = await db.exportDb();
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
  await writeStoredHandle(handle);

  return { name: handle.name || suggestedName };
}

export async function syncWriteToLocalFile() {
  const info = await getConnectedLocalFile();
  if (!info?.handle) return false;

  const perm = await info.handle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') return false;

  const bytes = await db.exportDb();
  const writable = await info.handle.createWritable();
  await writable.write(bytes);
  await writable.close();
  return true;
}

export function enableLocalFileAutoSave() {
  if (autoSaveUnsubscribe) return;
  autoSaveUnsubscribe = db.onWrite((event) => {
    if (event?.type === 'importDb') return;
    if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(() => {
      syncWriteToLocalFile().catch((err) => {
        console.warn('Auto-save to connected local SQLite file failed:', err);
      });
    }, 500);
  });
}
