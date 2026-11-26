import { type Database } from 'sql.js';
import { type DeltaBindValue } from '../gdrive.js';
import {
  formatLocalDateTime,
  queryAll,
  runStmt,
  type McpToolDefinition,
  type MutatingToolOutcome
} from './sqlite.js';

const WISHLIST_INSERT_COLUMNS = [
  'nama',
  'harga_estimasi',
  'link',
  'catatan',
  'created_at',
  'updated_at'
] as const;

const WISHLIST_UPDATE_COLUMNS = ['nama', 'harga_estimasi', 'link', 'catatan'] as const;

function normalizeBindValue(value: unknown): DeltaBindValue {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  return String(value);
}

export function executeListWishlist(db: Database): unknown {
  const rows = queryAll(db, 'SELECT * FROM WISHLIST ORDER BY created_at DESC');
  return { data: rows };
}

export function executeAddWishlist(db: Database, params: Record<string, unknown>): MutatingToolOutcome {
  if (!params.nama) {
    return {
      result: { success: false, error: 'Field nama wajib diisi.' },
      ops: []
    };
  }

  const data: Record<string, unknown> = {
    nama: params.nama,
    harga_estimasi: params.harga_estimasi ?? null,
    link: params.link ?? null,
    catatan: params.catatan ?? null
  };

  const cols: string[] = [];
  const placeholders: string[] = [];
  const bind: DeltaBindValue[] = [];

  for (const col of WISHLIST_INSERT_COLUMNS) {
    if (Object.hasOwn(data, col) && data[col] !== undefined) {
      cols.push(col);
      placeholders.push('?');
      bind.push(normalizeBindValue(data[col]));
    }
  }

  const sql = `INSERT INTO WISHLIST (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`;
  const res = runStmt(db, sql, bind);

  return {
    result: { success: true, id: res.lastInsertRowid, changes: res.changes },
    ops: [{ sql, bind }]
  };
}

export function executeUpdateWishlist(db: Database, params: Record<string, unknown>): MutatingToolOutcome {
  if (params.id === undefined || params.id === null || params.id === '') {
    return {
      result: { success: false, error: 'Field id wajib diisi.' },
      ops: []
    };
  }

  const { id, ...partialFields } = params;
  const assignments: string[] = [];
  const bind: DeltaBindValue[] = [];

  for (const col of WISHLIST_UPDATE_COLUMNS) {
    if (Object.hasOwn(partialFields, col) && partialFields[col] !== undefined) {
      assignments.push(`${col} = ?`);
      bind.push(normalizeBindValue(partialFields[col]));
    }
  }

  if (assignments.length === 0) {
    return {
      result: { success: true, id, changes: 0 },
      ops: []
    };
  }

  assignments.push('updated_at = ?');
  bind.push(formatLocalDateTime());
  bind.push(normalizeBindValue(id));

  const sql = `UPDATE WISHLIST SET ${assignments.join(', ')} WHERE id = ?`;
  const res = runStmt(db, sql, bind);
  return {
    result: { success: true, id, changes: res.changes },
    ops: [{ sql, bind }]
  };
}

export function executeDeleteWishlist(db: Database, params: Record<string, unknown>): MutatingToolOutcome {
  if (params.id === undefined || params.id === null || params.id === '') {
    return {
      result: { success: false, error: 'Field id wajib diisi.' },
      ops: []
    };
  }

  const sql = 'DELETE FROM WISHLIST WHERE id = ?';
  const bind: DeltaBindValue[] = [normalizeBindValue(params.id)];
  const res = runStmt(db, sql, bind);
  return {
    result: { success: true, id: params.id, changes: res.changes },
    ops: [{ sql, bind }]
  };
}

export const WISHLIST_TOOLS: McpToolDefinition[] = [
  {
    name: 'list_wishlist',
    description:
      'Mendapatkan seluruh isi Wishlist (barang yang sedang dipertimbangkan untuk dibeli, belum dicatat sebagai transaksi).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'add_wishlist',
    description: 'Menambahkan barang baru ke Wishlist.',
    inputSchema: {
      type: 'object',
      properties: {
        nama: { type: 'string', description: 'Nama barang' },
        harga_estimasi: {
          type: ['number', 'null'],
          description: 'Estimasi harga barang dalam Rupiah (opsional)'
        },
        link: { type: ['string', 'null'], description: 'Link/URL ke halaman produk (opsional)' },
        catatan: { type: ['string', 'null'], description: 'Catatan atau pertimbangan (opsional)' }
      },
      required: ['nama']
    }
  },
  {
    name: 'update_wishlist',
    description: 'Memperbarui item Wishlist berdasarkan ID. Hanya field yang dikirim yang akan diubah.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'ID item Wishlist yang akan diperbarui (wajib)' },
        nama: { type: ['string', 'null'] },
        harga_estimasi: { type: ['number', 'null'] },
        link: { type: ['string', 'null'] },
        catatan: { type: ['string', 'null'] }
      },
      required: ['id']
    }
  },
  {
    name: 'delete_wishlist',
    description: 'Menghapus item Wishlist berdasarkan ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'ID item Wishlist yang akan dihapus' }
      },
      required: ['id']
    }
  }
];
