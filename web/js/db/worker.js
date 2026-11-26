import sqlite3InitModule from 'https://cdn.jsdelivr.net/npm/@sqlite.org/sqlite-wasm@3.54.1-build1/dist/index.mjs';
import { initSchemaStatements } from './schema.js';

const SAHPOOL_DB_PATH = '/kasin.sqlite';
const IDB_NAME = 'kasin-idb';
const IDB_STORE = 'db';
const IDB_KEY = 'kasin.sqlite';

// "SQLite format 3\0"
const SQLITE_HEADER = [
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66,
  0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00
];

let sqlite3 = null;
let poolUtil = null;
let db = null;
let storageMode = null;
let opQueue = Promise.resolve();
const connectedPorts = new Set();

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const idb = req.result;
      if (!idb.objectStoreNames.contains(IDB_STORE)) {
        idb.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
}

async function loadFromIdb() {
  const idb = await openIdb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(IDB_KEY);
      req.onsuccess = () => {
        const val = req.result;
        if (!val) {
          resolve(null);
        } else if (val instanceof Uint8Array) {
          resolve(val);
        } else if (val instanceof ArrayBuffer) {
          resolve(new Uint8Array(val));
        } else {
          resolve(null);
        }
      };
      req.onerror = () => reject(req.error || new Error('Failed to read from IndexedDB'));
    });
  } finally {
    idb.close();
  }
}

async function saveToIdb(bytes) {
  const idb = await openIdb();
  try {
    await new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const req = store.put(bytes, IDB_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error('Failed to write to IndexedDB'));
    });
  } finally {
    idb.close();
  }
}

function exportActiveDbBytes() {
  const raw = sqlite3.capi.sqlite3_js_db_export(db.pointer);
  if (raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength) {
    return raw;
  }
  return raw.slice();
}

async function persistIfFallback() {
  if ((storageMode !== 'indexeddb' && storageMode !== 'shared-indexeddb') || !db) return;
  const bytes = exportActiveDbBytes();
  await saveToIdb(bytes);
}

function deserializeIntoMemoryDb(bytes) {
  const pMem = sqlite3.wasm.allocFromTypedArray(bytes);
  const rc = sqlite3.capi.sqlite3_deserialize(
    db.pointer,
    'main',
    pMem,
    bytes.byteLength,
    bytes.byteLength,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
  );
  sqlite3.oo1.DB.checkRc(db, rc);
}

function ensureDbInfoRow() {
  const rows = db.exec({
    sql: 'SELECT COUNT(*) AS cnt FROM DB_INFO',
    rowMode: 'object',
    returnValue: 'resultRows'
  });
  const cnt = rows.length > 0 ? Number(rows[0].cnt) : 0;
  if (cnt === 0) {
    const versionDate = new Date().toISOString();
    const fingerprint = typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    db.exec({
      sql: 'INSERT INTO DB_INFO (version_date, fingerprint) VALUES (?, ?)',
      bind: [versionDate, fingerprint]
    });
    return true;
  }
  return false;
}

function validateSqliteBytes(input) {
  const bytes = input instanceof Uint8Array
    ? input
    : input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : null;

  if (!bytes || bytes.byteLength < 100) {
    throw new Error('Invalid SQLite file: payload is empty or too small.');
  }
  for (let i = 0; i < SQLITE_HEADER.length; i += 1) {
    if (bytes[i] !== SQLITE_HEADER[i]) {
      throw new Error('Invalid SQLite file: missing "SQLite format 3" header.');
    }
  }
  return bytes;
}

function assertReady() {
  if (!db) {
    throw new Error('Database is not initialized. Call init() first.');
  }
}

async function handleInit() {
  if (db) {
    return { storageMode };
  }

  sqlite3 = await sqlite3InitModule();

  const isSharedWorker = typeof self.onconnect !== 'undefined';
  if (isSharedWorker) {
    storageMode = 'shared-indexeddb';
    db = new sqlite3.oo1.DB(':memory:');
    const saved = await loadFromIdb();
    if (saved && saved.byteLength >= 100) {
      deserializeIntoMemoryDb(saved);
    }
  } else {
    try {
      poolUtil = await sqlite3.installOpfsSAHPoolVfs();
      db = new poolUtil.OpfsSAHPoolDb(SAHPOOL_DB_PATH);
      storageMode = 'opfs-sahpool';
    } catch {
      storageMode = 'indexeddb';
      db = new sqlite3.oo1.DB(':memory:');
      const saved = await loadFromIdb();
      if (saved && saved.byteLength >= 100) {
        deserializeIntoMemoryDb(saved);
      }
    }
  }

  const schema = initSchemaStatements(db);
  ensureDbInfoRow();
  await persistIfFallback();

  return { storageMode, schema };
}

function handleQueryAll(sql, bind = []) {
  assertReady();
  return db.exec({
    sql,
    bind,
    rowMode: 'object',
    returnValue: 'resultRows'
  });
}

function handleQueryOne(sql, bind = []) {
  assertReady();
  const rows = db.exec({
    sql,
    bind,
    rowMode: 'object',
    returnValue: 'resultRows'
  });
  return rows.length > 0 ? rows[0] : null;
}

async function handleRun(sql, bind = []) {
  assertReady();
  db.exec({ sql, bind });
  const result = {
    changes: db.changes(),
    lastInsertRowid: Number(sqlite3.capi.sqlite3_last_insert_rowid(db.pointer))
  };
  await persistIfFallback();
  return result;
}

async function handleTransaction(ops = []) {
  assertReady();
  if (!Array.isArray(ops)) {
    throw new Error('transaction(ops) requires an array of { sql, bind }.');
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const results = [];
    for (const op of ops) {
      const bind = Array.isArray(op.bind) ? [...op.bind] : [];
      if (Number.isInteger(op.relasiRefIndex) && Number.isInteger(op.relasiParamIndex)) {
        const target = results[op.relasiRefIndex];
        if (!target) {
          throw new Error(`Invalid relative row reference at index ${results.length}`);
        }
        bind[op.relasiParamIndex] = target.lastInsertRowid;
      }
      db.exec({ sql: op.sql, bind });
      results.push({
        changes: db.changes(),
        lastInsertRowid: Number(sqlite3.capi.sqlite3_last_insert_rowid(db.pointer))
      });
    }
    db.exec('COMMIT');
    await persistIfFallback();
    return results;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback errors if transaction was already aborted
    }
    throw err;
  }
}

function handleExportDb() {
  assertReady();
  const bytes = exportActiveDbBytes();
  return {
    result: bytes,
    transfer: [bytes.buffer]
  };
}

async function handleImportDb(input) {
  assertReady();
  const bytes = validateSqliteBytes(input);

  if (storageMode === 'opfs-sahpool') {
    db.close();
    db = null;
    try {
      try {
        await poolUtil.importDb(SAHPOOL_DB_PATH, bytes);
      } catch {
        try {
          poolUtil.unlink(SAHPOOL_DB_PATH);
        } catch {
          // Ignore if file did not exist
        }
        await poolUtil.importDb(SAHPOOL_DB_PATH, bytes);
      }
    } finally {
      db = new poolUtil.OpfsSAHPoolDb(SAHPOOL_DB_PATH);
    }
  } else {
    db.close();
    db = new sqlite3.oo1.DB(':memory:');
    deserializeIntoMemoryDb(bytes);
  }

  const schema = initSchemaStatements(db);
  ensureDbInfoRow();
  await persistIfFallback();

  return { ok: true, schema };
}

function handleGetStorageMode() {
  return storageMode;
}

function broadcastDbUpdated(senderPort, method) {
  for (const port of connectedPorts) {
    if (port === senderPort) continue;
    try {
      port.postMessage({ broadcast: 'db-updated', method });
    } catch {
      connectedPorts.delete(port);
    }
  }
}

function handleRpcMessage(port, event) {
  const { id, method, params = [] } = event.data || {};
  if (id === undefined || !method) return;

  opQueue = opQueue.then(async () => {
    try {
      let result;
      let transfer = [];

      switch (method) {
        case 'init':
          result = await handleInit();
          break;
        case 'queryAll':
          result = handleQueryAll(params[0], params[1]);
          break;
        case 'queryOne':
          result = handleQueryOne(params[0], params[1]);
          break;
        case 'run':
          result = await handleRun(params[0], params[1]);
          break;
        case 'transaction':
          result = await handleTransaction(params[0]);
          break;
        case 'exportDb': {
          const exported = handleExportDb();
          result = exported.result;
          transfer = exported.transfer;
          break;
        }
        case 'importDb':
          result = await handleImportDb(params[0]);
          break;
        case 'getStorageMode':
          result = handleGetStorageMode();
          break;
        default:
          throw new Error(`Unknown worker method: ${method}`);
      }

      port.postMessage({ id, ok: true, result }, transfer);

      if (method === 'run' || method === 'transaction' || method === 'importDb') {
        broadcastDbUpdated(port, method);
      }
    } catch (err) {
      port.postMessage({
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  });
}

self.addEventListener('connect', (connectEvent) => {
  const port = connectEvent.ports?.[0];
  if (!port) return;
  connectedPorts.add(port);
  port.addEventListener('message', (event) => handleRpcMessage(port, event));
  port.addEventListener('messageerror', () => {
    connectedPorts.delete(port);
  });
  port.start();
});

self.addEventListener('message', (event) => {
  handleRpcMessage(self, event);
});
