import { type Database, type SqlValue } from 'sql.js';
import { type DeltaBindValue, type DeltaOp } from '../gdrive.js';
import {
  formatDBDate,
  queryAll,
  runStmt,
  type McpToolDefinition,
  type MutatingToolOutcome
} from './sqlite.js';

const MAX_BATCH_UPDATE = 15;

const TRANSAKSI_INSERT_COLUMNS = [
  'jenis_transaksi',
  'harta',
  'barang',
  'rekening_sumber',
  'rekening_masuk',
  'nominal',
  'nominal_asing',
  'kuantitas',
  'penyusutan_bunga',
  'rutin',
  'kelompok',
  'tanggal',
  'relasi_transaksi',
  'attachment',
  'keterangan',
  'review',
  'created_at'
] as const;

const TRANSAKSI_UPDATE_COLUMNS = [
  'jenis_transaksi',
  'harta',
  'barang',
  'rekening_sumber',
  'rekening_masuk',
  'nominal',
  'nominal_asing',
  'kuantitas',
  'penyusutan_bunga',
  'rutin',
  'kelompok',
  'tanggal',
  'relasi_transaksi',
  'attachment',
  'keterangan',
  'review'
] as const;

const BOOLEAN_COLUMNS = new Set(['harta', 'rutin']);

function normalizeColumnValue(col: string, value: unknown): DeltaBindValue {
  if (BOOLEAN_COLUMNS.has(col)) {
    return value ? 1 : 0;
  }
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

function normalizeJenisTransaksi(jenis: unknown): string {
  if (jenis === 'Operasi') return 'Pindah Buku';
  return typeof jenis === 'string' ? jenis : '';
}

function normalizeBatchItem(rawItem: Record<string, unknown>, index: number): Record<string, unknown> {
  if (!rawItem || typeof rawItem !== 'object') {
    throw new Error(`Item pada indeks ${index} tidak valid.`);
  }
  const jenis = normalizeJenisTransaksi(rawItem.jenis_transaksi);
  if (!jenis || !rawItem.barang || rawItem.nominal === undefined || rawItem.nominal === null) {
    throw new Error(`Item pada indeks ${index} wajib memiliki jenis_transaksi, barang, dan nominal.`);
  }

  let relasi: string | number | null = (rawItem.relasi_transaksi as string | number | null | undefined) ?? null;
  if (typeof relasi === 'string') {
    const trimmed = relasi.trim();
    if (trimmed === '') {
      relasi = null;
    } else if (/^@\d+$/.test(trimmed)) {
      relasi = `#${trimmed.slice(1)}`;
    } else if (/^\d+$/.test(trimmed)) {
      relasi = Number.parseInt(trimmed, 10);
    } else {
      relasi = trimmed;
    }
  }

  const kelompok =
    rawItem.kelompok !== undefined && rawItem.kelompok !== null && String(rawItem.kelompok).trim() !== ''
      ? String(rawItem.kelompok).trim()
      : null;

  return {
    jenis_transaksi: jenis,
    harta: Boolean(rawItem.harta),
    barang: String(rawItem.barang),
    rekening_sumber: rawItem.rekening_sumber ?? null,
    rekening_masuk: rawItem.rekening_masuk ?? null,
    nominal: Number(rawItem.nominal),
    nominal_asing:
      rawItem.nominal_asing !== undefined && rawItem.nominal_asing !== null
        ? Number(rawItem.nominal_asing)
        : 0,
    kuantitas:
      rawItem.kuantitas !== undefined && rawItem.kuantitas !== null ? Number(rawItem.kuantitas) : 1,
    penyusutan_bunga:
      rawItem.penyusutan_bunga !== undefined && rawItem.penyusutan_bunga !== null
        ? Number(rawItem.penyusutan_bunga)
        : 0,
    rutin: kelompok === null ? false : Boolean(rawItem.rutin),
    kelompok,
    tanggal: rawItem.tanggal ? String(rawItem.tanggal) : formatDBDate(new Date()),
    relasi_transaksi: relasi,
    attachment: rawItem.attachment ? 'uploading' : null,
    keterangan: rawItem.keterangan ?? null
  };
}

function buildTransaksiInsertStatement(data: Record<string, unknown>): {
  sql: string;
  bind: DeltaBindValue[];
  cols: string[];
} {
  const cols: string[] = [];
  const placeholders: string[] = [];
  const bind: DeltaBindValue[] = [];

  for (const col of TRANSAKSI_INSERT_COLUMNS) {
    if (Object.hasOwn(data, col) && data[col] !== undefined) {
      cols.push(col);
      placeholders.push('?');
      bind.push(normalizeColumnValue(col, data[col]));
    }
  }

  if (cols.length === 0) {
    throw new Error('No valid columns provided for TRANSAKSI insert.');
  }

  return {
    sql: `INSERT INTO TRANSAKSI (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
    bind,
    cols
  };
}

export function executeCatatTransaksi(db: Database, params: Record<string, unknown>): MutatingToolOutcome {
  const rawItems = Array.isArray(params.data)
    ? params.data
    : params.jenis_transaksi && params.barang
      ? [params]
      : [];

  if (rawItems.length === 0) {
    return {
      result: { success: false, error: 'Parameter data harus berupa array transaksi yang tidak kosong.' },
      ops: []
    };
  }

  const autoRelate = Boolean(params.autoRelate);
  const normalizedItems = rawItems.map((item, idx) =>
    normalizeBatchItem(item as Record<string, unknown>, idx)
  );

  const ops: DeltaOp[] = normalizedItems.map((rawItem, i) => {
    const item = { ...rawItem };
    const rawRel = item.relasi_transaksi;
    let relasiRefIndex: number | null = null;

    if (typeof rawRel === 'string' && /^#\d+$/.test(rawRel.trim())) {
      const refNum = Number.parseInt(rawRel.trim().slice(1), 10);
      const refIdx = refNum - 1;
      if (refIdx < 0 || refIdx >= i) {
        throw new Error(`Invalid relative reference "${rawRel}" at batch index ${i}.`);
      }
      relasiRefIndex = refIdx;
      item.relasi_transaksi = null;
    } else if (autoRelate && i > 0 && (rawRel === undefined || rawRel === null || rawRel === '')) {
      relasiRefIndex = 0;
      item.relasi_transaksi = null;
    }

    const { sql, bind, cols } = buildTransaksiInsertStatement(item);
    const relasiParamIndex = relasiRefIndex !== null ? cols.indexOf('relasi_transaksi') : -1;
    const op: DeltaOp = { sql, bind };
    if (relasiRefIndex !== null && relasiParamIndex >= 0) {
      op.relasiRefIndex = relasiRefIndex;
      op.relasiParamIndex = relasiParamIndex;
    }
    return op;
  });

  const results: Array<{ id: number; changes: number }> = [];
  db.run('BEGIN IMMEDIATE');
  try {
    for (const op of ops) {
      const bind: SqlValue[] = [...op.bind];
      if (
        Number.isInteger(op.relasiRefIndex) &&
        Number.isInteger(op.relasiParamIndex) &&
        (op.relasiParamIndex as number) >= 0
      ) {
        bind[op.relasiParamIndex as number] = results[op.relasiRefIndex as number].id;
      }
      const res = runStmt(db, op.sql, bind);
      results.push({ id: res.lastInsertRowid, changes: res.changes });
    }
    db.run('COMMIT');
  } catch (err) {
    try {
      db.run('ROLLBACK');
    } catch {
      // Ignore rollback errors
    }
    throw err;
  }

  return {
    result: {
      success: true,
      count: results.length,
      ids: results.map((r) => r.id),
      data: results
    },
    ops
  };
}

export function executeGetTransaksi(db: Database, params: Record<string, unknown>): unknown {
  const search =
    params.search !== undefined && params.search !== null && String(params.search).trim() !== ''
      ? String(params.search).trim()
      : null;
  let startDate = typeof params.startDate === 'string' && params.startDate ? params.startDate : null;
  let endDate = typeof params.endDate === 'string' && params.endDate ? params.endDate : null;
  const jenis_transaksi =
    typeof params.jenis_transaksi === 'string' && params.jenis_transaksi
      ? params.jenis_transaksi
      : null;
  const kelompok = typeof params.kelompok === 'string' && params.kelompok ? params.kelompok : null;
  const rekening =
    params.rekening !== undefined && params.rekening !== null && params.rekening !== ''
      ? Number(params.rekening)
      : null;
  const limit = params.limit !== undefined && params.limit !== null ? Number(params.limit) : 100;

  if (
    search === null &&
    startDate === null &&
    endDate === null &&
    jenis_transaksi === null &&
    kelompok === null &&
    rekening === null
  ) {
    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    startDate = formatDBDate(firstOfMonth);
    endDate = formatDBDate(now);
  }

  const where: string[] = [];
  const bind: SqlValue[] = [];

  if (search !== null) {
    const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
    for (const term of terms) {
      const like = `%${term}%`;
      where.push(
        `(printf('%04d', t.id) LIKE ? OR LOWER(t.barang) LIKE ? OR LOWER(t.kelompok) LIKE ?
          OR LOWER(t.keterangan) LIKE ? OR LOWER(t.review) LIKE ? OR LOWER(rs.nama) LIKE ? OR LOWER(rm.nama) LIKE ?)`
      );
      bind.push(like, like, like, like, like, like, like);
    }
  }

  if (startDate !== null) {
    where.push('t.tanggal >= ?');
    bind.push(startDate);
  }
  if (endDate !== null) {
    where.push('t.tanggal <= ?');
    bind.push(endDate);
  }
  if (jenis_transaksi !== null) {
    where.push('t.jenis_transaksi = ?');
    bind.push(jenis_transaksi);
  }
  if (kelompok !== null) {
    where.push('LOWER(t.kelompok) = ?');
    bind.push(kelompok.toLowerCase());
  }
  if (rekening !== null && !Number.isNaN(rekening)) {
    where.push('(t.rekening_sumber = ? OR t.rekening_masuk = ?)');
    bind.push(rekening, rekening);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const safeLimit = Math.max(1, Math.min(Number.isNaN(limit) ? 100 : Math.trunc(limit), 500));
  bind.push(safeLimit);

  const rows = queryAll(
    db,
    `SELECT
      t.*,
      rs.nama AS nama_rekening_sumber,
      rm.nama AS nama_rekening_masuk,
      rs.jenis_uang AS jenis_budget_sumber,
      rm.jenis_uang AS jenis_budget_masuk
    FROM TRANSAKSI t
    LEFT JOIN REKENING rs ON t.rekening_sumber = rs.id
    LEFT JOIN REKENING rm ON t.rekening_masuk = rm.id
    ${whereSql}
    ORDER BY t.tanggal DESC, t.id DESC
    LIMIT ?`,
    bind
  );

  const data = rows.map((row) => ({
    ...row,
    harta: Boolean(row.harta),
    rutin: Boolean(row.rutin)
  }));

  return {
    count: data.length,
    data
  };
}

export function executeUpdateTransaksi(db: Database, params: Record<string, unknown>): MutatingToolOutcome {
  const rawItems = Array.isArray(params.data)
    ? params.data
    : params.id !== undefined
      ? [params]
      : [];

  if (rawItems.length === 0) {
    return {
      result: { success: false, error: 'Parameter data harus berisi minimal 1 objek dengan field id.' },
      ops: []
    };
  }

  const itemsToProcess = rawItems.slice(0, MAX_BATCH_UPDATE);
  const results: Array<{ id: number | string; changes: number }> = [];
  const ops: DeltaOp[] = [];

  db.run('BEGIN IMMEDIATE');
  try {
    for (const rawItem of itemsToProcess) {
      const item = rawItem as Record<string, unknown>;
      if (!item || item.id === undefined || item.id === null || item.id === '') {
        throw new Error('Setiap item update_transaksi wajib menyertakan field "id".');
      }
      const { id, ...partialFields } = item;
      if (Object.hasOwn(partialFields, 'jenis_transaksi')) {
        partialFields.jenis_transaksi = normalizeJenisTransaksi(partialFields.jenis_transaksi);
      }

      const assignments: string[] = [];
      const bind: DeltaBindValue[] = [];
      for (const col of TRANSAKSI_UPDATE_COLUMNS) {
        if (Object.hasOwn(partialFields, col) && partialFields[col] !== undefined) {
          assignments.push(`${col} = ?`);
          bind.push(normalizeColumnValue(col, partialFields[col]));
        }
      }

      if (assignments.length === 0) {
        results.push({ id: id as number | string, changes: 0 });
        continue;
      }

      bind.push(normalizeColumnValue('id', id));
      const sql = `UPDATE TRANSAKSI SET ${assignments.join(', ')} WHERE id = ?`;
      const res = runStmt(db, sql, bind);
      ops.push({ sql, bind });
      results.push({ id: id as number | string, changes: res.changes });
    }
    db.run('COMMIT');
  } catch (err) {
    try {
      db.run('ROLLBACK');
    } catch {
      // Ignore rollback errors
    }
    throw err;
  }

  return {
    result: {
      success: true,
      updated: results.length,
      data: results
    },
    ops
  };
}

export function executeGetKelompok(db: Database): unknown {
  const rows = queryAll(
    db,
    `SELECT kelompok, COUNT(1) AS count, rutin FROM TRANSAKSI
    WHERE rutin = 1
      OR (rutin = 0 AND tanggal >= date('now', '-30 days'))
    GROUP BY kelompok, rutin
    ORDER BY count DESC`
  );

  return {
    data: rows.map((r) => ({
      kelompok: r.kelompok,
      rutin: Boolean(r.rutin),
      count: Number(r.count)
    }))
  };
}

export const TRANSAKSI_TOOLS: McpToolDefinition[] = [
  {
    name: 'catat_transaksi',
    description:
      'Mencatat satu atau beberapa transaksi keuangan baru secara batch (Pemasukan, Pengeluaran, atau Pindah Buku) ke database KasIn. Wajib tampilkan rekap dan tunggu konfirmasi user sebelum memanggil tool ini.',
    inputSchema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          description: 'Daftar transaksi yang akan dicatat.',
          items: {
            type: 'object',
            properties: {
              jenis_transaksi: {
                type: 'string',
                enum: ['Pengeluaran', 'Pemasukan', 'Pindah Buku'],
                description: 'Jenis transaksi: Pengeluaran, Pemasukan, atau Pindah Buku'
              },
              harta: {
                type: 'boolean',
                description:
                  'Set true jika transaksi terkait Aset Harta (hanya pada Pemasukan/Pengeluaran rekening Harta).'
              },
              barang: {
                type: 'string',
                description:
                  'Nama barang/deskripsi singkat yang terdiversifikasi (contoh: "Nasi Padang", "Mouse Wireless").'
              },
              rekening_sumber: {
                type: ['integer', 'null'],
                description: 'ID rekening sumber dari get_rekening (wajib untuk Pengeluaran atau Pindah Buku).'
              },
              rekening_masuk: {
                type: ['integer', 'null'],
                description: 'ID rekening tujuan dari get_rekening (wajib untuk Pemasukan atau Pindah Buku).'
              },
              nominal: {
                type: 'number',
                description: 'Nominal per unit dalam Rupiah (IDR).'
              },
              nominal_asing: {
                type: ['number', 'null'],
                description: 'Nominal dalam mata uang/satuan asing (misal gram emas atau USD).'
              },
              kuantitas: {
                type: 'number',
                description: 'Jumlah unit (default: 1).'
              },
              penyusutan_bunga: {
                type: 'number',
                description: 'Penyusutan atau bunga buku per bulan dalam Rupiah (untuk Pemasukan Aset Harta).'
              },
              rutin: {
                type: 'boolean',
                description: 'True jika transaksi rutin/berkala. Wajib false jika kelompok bernilai null.'
              },
              kelompok: {
                type: ['string', 'null'],
                description: 'Kategori transaksi atau null untuk pembelian insidentil/tidak biasa.'
              },
              tanggal: {
                type: 'string',
                description: 'Tanggal transaksi format YYYY-MM-DD (default: hari ini).'
              },
              relasi_transaksi: {
                type: ['string', 'integer', 'null'],
                description: 'Referensi baris batch ("#1", "#2") atau ID transaksi DB yang sudah ada.'
              },
              keterangan: {
                type: ['string', 'null'],
                description: 'Catatan detail transaksi (nama toko, SKU, nomor nota).'
              },
              attachment: {
                type: 'boolean',
                description: 'Set true jika transaksi membutuhkan lampiran bukti/garansi.'
              }
            },
            required: ['jenis_transaksi', 'barang', 'nominal']
          }
        },
        autoRelate: {
          type: 'boolean',
          description: 'Jika true, item baris #2 dst otomatis berelasi ke baris #1.'
        }
      },
      required: ['data']
    }
  },
  {
    name: 'get_transaksi',
    description:
      'Mengambil atau mencari riwayat transaksi. Semua filter opsional (AND). Tanpa filter apapun akan mengembalikan transaksi bulan berjalan.',
    inputSchema: {
      type: 'object',
      properties: {
        search: {
          type: ['string', 'null'],
          description: 'Kata kunci (ID 4 digit, barang, kelompok, keterangan, review, nama rekening).'
        },
        startDate: {
          type: ['string', 'null'],
          description: 'Tanggal awal (YYYY-MM-DD).'
        },
        endDate: {
          type: ['string', 'null'],
          description: 'Tanggal akhir (YYYY-MM-DD).'
        },
        jenis_transaksi: {
          type: ['string', 'null'],
          enum: ['Pengeluaran', 'Pemasukan', 'Pindah Buku', null],
          description: 'Filter jenis transaksi.'
        },
        kelompok: {
          type: ['string', 'null'],
          description: 'Filter nama kelompok.'
        },
        rekening: {
          type: ['integer', 'null'],
          description: 'Filter ID rekening (sumber maupun tujuan).'
        },
        limit: {
          type: 'integer',
          description: 'Jumlah maksimal hasil (1-500, default 100).'
        }
      }
    }
  },
  {
    name: 'update_transaksi',
    description:
      'Partial update massal hingga 15 transaksi berdasarkan ID. Hanya field "id" yang wajib; field yang tidak dikirim tidak akan diubah.',
    inputSchema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          description:
            'Daftar objek transaksi berisi "id" dan hanya field yang ingin diperbarui (maksimal 15 item).',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer', description: 'ID transaksi yang akan diperbarui (wajib).' },
              jenis_transaksi: { type: 'string', enum: ['Pengeluaran', 'Pemasukan', 'Pindah Buku'] },
              harta: { type: 'boolean' },
              barang: { type: 'string' },
              rekening_sumber: { type: ['integer', 'null'] },
              rekening_masuk: { type: ['integer', 'null'] },
              nominal: { type: 'number' },
              nominal_asing: { type: ['number', 'null'] },
              kuantitas: { type: 'number' },
              penyusutan_bunga: { type: 'number' },
              rutin: { type: 'boolean' },
              kelompok: { type: ['string', 'null'] },
              tanggal: { type: ['string', 'null'] },
              relasi_transaksi: { type: ['integer', 'null'] },
              keterangan: { type: ['string', 'null'] },
              review: { type: ['string', 'null'] },
              attachment: { type: ['string', 'boolean', 'null'] }
            },
            required: ['id']
          }
        }
      },
      required: ['data']
    }
  },
  {
    name: 'get_kelompok',
    description: 'Mendapatkan daftar kategori/kelompok transaksi beserta frekuensi rutin/non-rutin.',
    inputSchema: { type: 'object', properties: {} }
  }
];
