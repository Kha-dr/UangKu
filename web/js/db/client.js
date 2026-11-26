const ATTACHMENTS_DIR = 'attachments';
const ATTACHMENTS_IDB_NAME = 'kasin-attachments';
const ATTACHMENTS_IDB_STORE = 'files';

let workerPort = null;
let workerOwner = null;
let nextRpcId = 1;
const pending = new Map();
const writeListeners = new Set();
let initPromise = null;

function handleWorkerMessage(event) {
  const data = event.data || {};
  if (data.broadcast === 'db-updated') {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('kasin:db-updated', {
          detail: { source: 'shared-worker', method: data.method }
        })
      );
    }
    return;
  }

  const { id, ok, result, error } = data;
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  if (ok) {
    entry.resolve(result);
  } else {
    entry.reject(new Error(error || 'Database worker error'));
  }
}

function handleWorkerError(event) {
  const err = new Error(event?.message || 'Database worker crashed');
  for (const entry of pending.values()) {
    entry.reject(err);
  }
  pending.clear();
}

function getPort() {
  if (!workerPort) {
    const workerUrl = new URL('./worker.js', import.meta.url);
    if (typeof SharedWorker !== 'undefined') {
      const shared = new SharedWorker(workerUrl, { type: 'module', name: 'kasin-sqlite' });
      workerOwner = shared;
      workerPort = shared.port;
      workerPort.addEventListener('message', handleWorkerMessage);
      workerPort.addEventListener('messageerror', handleWorkerError);
      shared.addEventListener('error', handleWorkerError);
      workerPort.start();
    } else {
      const dedicated = new Worker(workerUrl, { type: 'module' });
      workerOwner = dedicated;
      workerPort = dedicated;
      dedicated.addEventListener('message', handleWorkerMessage);
      dedicated.addEventListener('error', handleWorkerError);
    }
  }
  return workerPort;
}

function callWorker(method, params = [], transfer = []) {
  const id = nextRpcId;
  nextRpcId += 1;
  const port = getPort();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port.postMessage({ id, method, params }, transfer);
  });
}

function notifyWrite(event) {
  for (const listener of writeListeners) {
    try {
      listener(event);
    } catch {
      // Keep other write listeners isolated from subscriber errors
    }
  }
}

async function init() {
  if (!initPromise) {
    initPromise = callWorker('init').catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

async function queryAll(sql, bind = []) {
  await init();
  return callWorker('queryAll', [sql, bind]);
}

async function queryOne(sql, bind = []) {
  await init();
  return callWorker('queryOne', [sql, bind]);
}

async function run(sql, bind = []) {
  await init();
  const res = await callWorker('run', [sql, bind]);
  notifyWrite({ type: 'run', ops: [{ sql, bind }] });
  return res;
}

async function transaction(ops) {
  await init();
  const res = await callWorker('transaction', [ops]);
  notifyWrite({ type: 'transaction', ops });
  return res;
}

async function exportDb() {
  await init();
  return callWorker('exportDb');
}

async function importDb(uint8Array) {
  await init();
  const copy = uint8Array instanceof Uint8Array
    ? uint8Array.slice()
    : new Uint8Array(uint8Array);
  const res = await callWorker('importDb', [copy], [copy.buffer]);
  notifyWrite({ type: 'importDb' });
  return res;
}

async function getStorageMode() {
  await init();
  return callWorker('getStorageMode');
}

function onWrite(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('onWrite(listener) requires a function');
  }
  writeListeners.add(listener);
  return () => {
    writeListeners.delete(listener);
  };
}

export const db = {
  init,
  queryAll,
  queryOne,
  run,
  transaction,
  exportDb,
  importDb,
  getStorageMode,
  onWrite
};

function sanitizeFilename(filename) {
  if (typeof filename !== 'string') {
    throw new Error('Attachment filename must be a string.');
  }
  const trimmed = filename.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    throw new Error('Invalid attachment filename.');
  }
  return trimmed;
}

async function getOpfsAttachmentsDir() {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    return null;
  }
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(ATTACHMENTS_DIR, { create: true });
  } catch {
    return null;
  }
}

function openAttachmentsIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(ATTACHMENTS_IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const idb = req.result;
      if (!idb.objectStoreNames.contains(ATTACHMENTS_IDB_STORE)) {
        idb.createObjectStore(ATTACHMENTS_IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open attachments IndexedDB'));
  });
}

/**
 * Save a Blob or File attachment to OPFS (with IndexedDB fallback).
 * @param {string} filename
 * @param {Blob|File} blobOrFile
 * @returns {Promise<string>}
 */
export async function saveAttachment(filename, blobOrFile) {
  const name = sanitizeFilename(filename);
  const dir = await getOpfsAttachmentsDir();
  if (dir) {
    const fileHandle = await dir.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blobOrFile);
    await writable.close();
    return name;
  }

  const idb = await openAttachmentsIdb();
  try {
    await new Promise((resolve, reject) => {
      const tx = idb.transaction(ATTACHMENTS_IDB_STORE, 'readwrite');
      const req = tx.objectStore(ATTACHMENTS_IDB_STORE).put(blobOrFile, name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error('Failed to save attachment'));
    });
    return name;
  } finally {
    idb.close();
  }
}

/**
 * Read an attachment Blob from OPFS (with IndexedDB fallback).
 * Returns null if the attachment does not exist.
 * @param {string} filename
 * @returns {Promise<Blob|null>}
 */
export async function readAttachment(filename) {
  const name = sanitizeFilename(filename);
  const dir = await getOpfsAttachmentsDir();
  if (dir) {
    try {
      const fileHandle = await dir.getFileHandle(name);
      return await fileHandle.getFile();
    } catch (err) {
      if (err?.name === 'NotFoundError') return null;
      throw err;
    }
  }

  const idb = await openAttachmentsIdb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = idb.transaction(ATTACHMENTS_IDB_STORE, 'readonly');
      const req = tx.objectStore(ATTACHMENTS_IDB_STORE).get(name);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('Failed to read attachment'));
    });
  } finally {
    idb.close();
  }
}

/**
 * Delete an attachment from OPFS (with IndexedDB fallback).
 * @param {string} filename
 * @returns {Promise<void>}
 */
export async function deleteAttachment(filename) {
  const name = sanitizeFilename(filename);
  const dir = await getOpfsAttachmentsDir();
  if (dir) {
    try {
      await dir.removeEntry(name);
    } catch (err) {
      if (err?.name !== 'NotFoundError') throw err;
    }
    return;
  }

  const idb = await openAttachmentsIdb();
  try {
    await new Promise((resolve, reject) => {
      const tx = idb.transaction(ATTACHMENTS_IDB_STORE, 'readwrite');
      const req = tx.objectStore(ATTACHMENTS_IDB_STORE).delete(name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error('Failed to delete attachment'));
    });
  } finally {
    idb.close();
  }
}

/**
 * List stored attachment filenames from OPFS (with IndexedDB fallback).
 * @returns {Promise<string[]>}
 */
export async function listAttachments() {
  const dir = await getOpfsAttachmentsDir();
  if (dir) {
    const names = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file') {
        names.push(name);
      }
    }
    return names;
  }

  const idb = await openAttachmentsIdb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = idb.transaction(ATTACHMENTS_IDB_STORE, 'readonly');
      const req = tx.objectStore(ATTACHMENTS_IDB_STORE).getAllKeys();
      req.onsuccess = () => resolve((req.result || []).map(String));
      req.onerror = () => reject(req.error || new Error('Failed to list attachments'));
    });
  } finally {
    idb.close();
  }
}
