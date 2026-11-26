import { db } from '../db/client.js';

const TABLE = 'TRANSAKSI';

const ALLOWED_INSERT_COLUMNS = [
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
];

const ALLOWED_UPDATE_COLUMNS = [
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
];

const BOOLEAN_COLUMNS = new Set(['harta', 'rutin']);

function normalizeColumnValue(col, value) {
  if (BOOLEAN_COLUMNS.has(col)) {
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value ? 1 : 0;
  }
  return value === undefined ? null : value;
}

function formatLocalDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatLocalDateTime(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${formatLocalDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function buildInsertStatement(data, allowedColumns = ALLOWED_INSERT_COLUMNS) {
  const cols = [];
  const placeholders = [];
  const bind = [];

  for (const col of allowedColumns) {
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
    sql: `INSERT INTO ${TABLE} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
    bind,
    cols
  };
}

/**
 * Fetch a single transaction by numeric or zero-padded ID.
 * @param {string|number} id
 */
export async function getById(id) {
  if (id === null || id === undefined || id === '') return null;
  const raw = String(id).trim();
  const padded = /^\d+$/.test(raw) ? raw.padStart(4, '0') : raw;

  const row = await db.queryOne(
    `SELECT * FROM ${TABLE} WHERE printf('%04d', id) = ?`,
    [padded]
  );

  if (!row) return null;
  return {
    ...row,
    rutin: Boolean(row.rutin),
    harta: Boolean(row.harta)
  };
}

/**
 * Fetch all transactions in the same relation family as `id` and compute totals.
 * @param {string|number} id
 */
export async function getRelatedFamily(id) {
  const numId = Number.parseInt(id, 10);
  if (Number.isNaN(numId)) {
    return {
      count: 0,
      total: 0,
      total_in: 0,
      total_out: 0,
      net: 0,
      data: []
    };
  }

  const rows = await db.queryAll(
    `WITH RECURSIVE related(id, relasi_transaksi) AS (
      SELECT id, relasi_transaksi FROM ${TABLE} WHERE id = ?
      UNION
      SELECT t.id, t.relasi_transaksi
      FROM ${TABLE} t
      JOIN related r ON t.relasi_transaksi = r.id OR r.relasi_transaksi = t.id
    )
    SELECT
      t.*,
      printf('%04d', t.id) AS formatted_id,
      rs.nama AS nama_rekening_sumber,
      rm.nama AS nama_rekening_masuk,
      COALESCE(NULLIF(rs.nominal_asing, ''), NULLIF(rm.nominal_asing, ''), '') AS mata_uang,
      (t.nominal * t.kuantitas) AS total_idr
    FROM ${TABLE} t
    JOIN related rel ON t.id = rel.id
    LEFT JOIN REKENING rs ON t.rekening_sumber = rs.id
    LEFT JOIN REKENING rm ON t.rekening_masuk = rm.id
    ORDER BY t.id ASC`,
    [numId]
  );

  let totalIn = 0;
  let totalOut = 0;
  let totalAll = 0;

  for (const row of rows) {
    const sub = Number(row.total_idr) || 0;
    totalAll += sub;
    if (row.jenis_transaksi === 'Pemasukan') {
      totalIn += sub;
    } else if (row.jenis_transaksi === 'Pengeluaran') {
      totalOut += sub;
    }
    // Pindah Buku is neutral for net (money moves between own accounts)
  }

  return {
    count: rows.length,
    total: totalAll,
    total_in: totalIn,
    total_out: totalOut,
    net: totalIn - totalOut,
    data: rows
  };
}

/**
 * Fetch transactions within an inclusive date range.
 * @param {string} startDate
 * @param {string} endDate
 */
export async function getInRange(startDate, endDate) {
  return db.queryAll(
    `SELECT
      t.*,
      rs.nama AS nama_rekening_sumber,
      rm.nama AS nama_rekening_masuk,
      rs.jenis_uang AS jenis_budget_sumber,
      rm.jenis_uang AS jenis_budget_masuk,
      rs.harta AS rs_aset,
      rm.harta AS rm_aset,
      COALESCE(NULLIF(rs.nominal_asing, ''), NULLIF(rm.nominal_asing, ''), '') AS mata_uang
    FROM ${TABLE} t
    LEFT JOIN REKENING rs ON t.rekening_sumber = rs.id
    LEFT JOIN REKENING rm ON t.rekening_masuk = rm.id
    WHERE t.tanggal BETWEEN ? AND ?`,
    [startDate, endDate]
  );
}

/**
 * Flexible filter query with multi-word search and optional exact filters.
 */
export async function filter({
  search = null,
  startDate = null,
  endDate = null,
  jenis_transaksi = null,
  kelompok = null,
  rekening = null,
  limit = 100
} = {}) {
  const where = [];
  const params = [];

  if (search !== null && search !== undefined) {
    const terms = String(search).trim().toLowerCase().split(/\s+/).filter(Boolean);
    for (const term of terms) {
      const like = `%${term}%`;
      where.push(
        `(printf('%04d', t.id) LIKE ? OR LOWER(t.barang) LIKE ? OR LOWER(t.kelompok) LIKE ?
          OR LOWER(t.keterangan) LIKE ? OR LOWER(t.review) LIKE ? OR LOWER(rs.nama) LIKE ? OR LOWER(rm.nama) LIKE ?)`
      );
      params.push(like, like, like, like, like, like, like);
    }
  }

  if (startDate !== null && startDate !== undefined && startDate !== '') {
    where.push('t.tanggal >= ?');
    params.push(startDate);
  }
  if (endDate !== null && endDate !== undefined && endDate !== '') {
    where.push('t.tanggal <= ?');
    params.push(endDate);
  }
  if (jenis_transaksi !== null && jenis_transaksi !== undefined && jenis_transaksi !== '') {
    where.push('t.jenis_transaksi = ?');
    params.push(jenis_transaksi);
  }
  if (kelompok !== null && kelompok !== undefined && kelompok !== '') {
    where.push('LOWER(t.kelompok) = ?');
    params.push(String(kelompok).toLowerCase());
  }
  if (rekening !== null && rekening !== undefined && rekening !== '') {
    const rekId = Number(rekening);
    where.push('(t.rekening_sumber = ? OR t.rekening_masuk = ?)');
    params.push(rekId, rekId);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const parsedLimit = Number.parseInt(limit, 10);
  const safeLimit = Math.max(1, Math.min(Number.isNaN(parsedLimit) ? 100 : parsedLimit, 500));
  params.push(safeLimit);

  return db.queryAll(
    `SELECT
      t.*,
      rs.nama AS nama_rekening_sumber,
      rm.nama AS nama_rekening_masuk,
      rs.jenis_uang AS jenis_budget_sumber,
      rm.jenis_uang AS jenis_budget_masuk,
      rs.harta AS rs_aset,
      rm.harta AS rm_aset,
      COALESCE(NULLIF(rs.nominal_asing, ''), NULLIF(rm.nominal_asing, ''), '') AS mata_uang
    FROM ${TABLE} t
    LEFT JOIN REKENING rs ON t.rekening_sumber = rs.id
    LEFT JOIN REKENING rm ON t.rekening_masuk = rm.id
    ${whereSql}
    ORDER BY t.tanggal DESC, t.id DESC
    LIMIT ?`,
    params
  );
}

/**
 * List active/recent kelompok counts.
 */
export async function getKelompok() {
  const rows = await db.queryAll(
    `SELECT kelompok, COUNT(1) as count, rutin FROM ${TABLE}
    WHERE rutin = 1
      OR (rutin = 0 AND tanggal >= date('now', '-30 days'))
    GROUP BY kelompok, rutin
    ORDER BY count DESC`
  );

  return rows.map((r) => ({
    kelompok: r.kelompok,
    rutin: Boolean(r.rutin),
    count: Number(r.count)
  }));
}

/**
 * Search active/recent kelompok suggestions.
 * @param {string} search
 */
export async function searchKelompok(search) {
  const like = `%${String(search ?? '').toLowerCase()}%`;
  return db.queryAll(
    `SELECT kelompok FROM ${TABLE}
    WHERE LOWER(kelompok) LIKE ?
      AND (
        rutin = 1
        OR (rutin = 0 AND tanggal >= date('now', '-30 days'))
      )
    GROUP BY kelompok
    LIMIT 5`,
    [like]
  );
}

/**
 * List unrealized asset (harta = 1) purchase transactions with depreciated value.
 */
export async function getDaftarHarta() {
  return db.queryAll(
    `SELECT
      r.nama AS nama_rekening,
      CAST((julianday('now') - julianday(t.tanggal)) / 30.44 AS INTEGER) AS bulan_berjalan,
      (t.penyusutan_bunga * CAST((julianday('now') - julianday(t.tanggal)) / 30.44 AS INTEGER)) AS total_penyusutan_per_unit,
      MAX(1,
        (t.nominal - (t.penyusutan_bunga * CAST((julianday('now') - julianday(t.tanggal)) / 30.44 AS INTEGER))) * t.kuantitas
      ) AS nilai_sekarang,
      t.*
    FROM ${TABLE} t
    JOIN REKENING r ON t.rekening_masuk = r.id
    WHERE t.harta = 1
      AND t.jenis_transaksi = 'Pemasukan'
      AND t.id NOT IN (
        SELECT relasi_transaksi
        FROM ${TABLE}
        WHERE harta = 1 AND jenis_transaksi = 'Pengeluaran' AND relasi_transaksi IS NOT NULL
      )`
  );
}

/**
 * Insert a single transaction row.
 * @param {Record<string, unknown>} data
 */
export async function insertTransaksi(data) {
  const { sql, bind } = buildInsertStatement(data);
  const res = await db.run(sql, bind);
  return {
    id: res.lastInsertRowid,
    changes: res.changes
  };
}

/**
 * Insert multiple transactions atomically, supporting `#N` relative row references
 * and `autoRelate` (linking rows 1..N-1 to row 0's inserted ID).
 * @param {Array<Record<string, unknown>>} items
 * @param {boolean} autoRelate
 */
export async function insertBatch(items, autoRelate = false) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const ops = items.map((rawItem, i) => {
    const item = { ...rawItem };
    const rawRel = item.relasi_transaksi;
    let relasiRefIndex = null;

    if (typeof rawRel === 'string' && /^#\d+$/.test(rawRel.trim())) {
      const refNum = Number.parseInt(rawRel.trim().slice(1), 10);
      const refIdx = refNum - 1;
      if (refIdx < 0 || refIdx >= i) {
        throw new Error(`Invalid relative reference "${rawRel}" at batch index ${i}.`);
      }
      relasiRefIndex = refIdx;
      item.relasi_transaksi = null;
    } else if (
      autoRelate &&
      i > 0 &&
      (rawRel === undefined || rawRel === null || rawRel === '')
    ) {
      relasiRefIndex = 0;
      item.relasi_transaksi = null;
    }

    const { sql, bind, cols } = buildInsertStatement(item);
    const op = { sql, bind };

    if (relasiRefIndex !== null) {
      op.relasiRefIndex = relasiRefIndex;
      op.relasiParamIndex = cols.indexOf('relasi_transaksi');
    }

    return op;
  });

  const results = await db.transaction(ops);
  return results.map((res) => ({
    id: res.lastInsertRowid,
    changes: res.changes
  }));
}

/**
 * Partially update a transaction using whitelisted columns.
 * @param {string|number} id
 * @param {Record<string, unknown>} partialData
 */
export async function updateTransaksi(id, partialData = {}) {
  const assignments = [];
  const bind = [];

  for (const col of ALLOWED_UPDATE_COLUMNS) {
    if (Object.hasOwn(partialData, col) && partialData[col] !== undefined) {
      assignments.push(`${col} = ?`);
      bind.push(normalizeColumnValue(col, partialData[col]));
    }
  }

  if (assignments.length === 0) {
    return { changes: 0 };
  }

  bind.push(id);
  const res = await db.run(
    `UPDATE ${TABLE} SET ${assignments.join(', ')} WHERE id = ?`,
    bind
  );
  return { changes: res.changes };
}

/**
 * Delete a transaction by ID.
 * @param {string|number} id
 */
export async function deleteTransaksi(id) {
  const res = await db.run(`DELETE FROM ${TABLE} WHERE id = ?`, [id]);
  return { changes: res.changes };
}

export async function cashFlowGraph(startDate, endDate) {
  return db.queryAll(
    `SELECT
      tanggal,
      rutin,
      jenis_transaksi,
      SUM(nominal * kuantitas) AS trans,
      SUM(nominal_asing * kuantitas) AS trans_asing
    FROM ${TABLE}
    WHERE
      harta = 0
      AND jenis_transaksi IN ('Pemasukan', 'Pengeluaran')
      AND tanggal BETWEEN ? AND ?
    GROUP BY jenis_transaksi, rutin, tanggal`,
    [startDate, endDate]
  );
}

export async function rekeningCashFlowGraph(startDate, endDate, idRekening) {
  return db.queryAll(
    `SELECT
      tanggal,
      rutin,
      CASE
        WHEN rekening_sumber = ? THEN 'Pengeluaran'
        WHEN rekening_masuk = ? THEN 'Pemasukan'
      END AS jenis_transaksi,
      SUM(nominal * kuantitas) AS trans,
      SUM(nominal_asing * kuantitas) AS trans_asing
    FROM ${TABLE}
    WHERE
      tanggal BETWEEN ? AND ?
      AND (
        rekening_sumber = ? OR
        rekening_masuk = ?
      )
    GROUP BY tanggal, rutin,
      CASE
        WHEN rekening_sumber = ? THEN 'Pengeluaran'
        WHEN rekening_masuk = ? THEN 'Pemasukan'
      END`,
    [
      idRekening,
      idRekening,
      startDate,
      endDate,
      idRekening,
      idRekening,
      idRekening,
      idRekening
    ]
  );
}

export async function compsGraph(startDate, endDate) {
  return db.queryAll(
    `SELECT
      CASE
        WHEN kelompok IS NULL OR kelompok = '' THEN 'Lainnya'
        ELSE kelompok
      END AS name,
      SUM(nominal * kuantitas) AS value,
      CASE WHEN rutin = 1 THEN '#03a9f4aa' ELSE '#f44336aa'
        END AS color
    FROM ${TABLE}
    WHERE
      harta = 0
      AND jenis_transaksi = 'Pengeluaran'
      AND tanggal BETWEEN ? AND ?
    GROUP BY kelompok, rutin`,
    [startDate, endDate]
  );
}

export async function rekeningCompsGraph(startDate, endDate, idRekening) {
  return db.queryAll(
    `SELECT
      CASE
        WHEN kelompok IS NULL OR kelompok = '' THEN 'Lainnya'
        ELSE kelompok
      END AS name,
      SUM(nominal * kuantitas) AS value,
      CASE WHEN rutin = 1 THEN '#03a9f4aa' ELSE '#f44336aa'
        END AS color
    FROM ${TABLE}
    WHERE
      (jenis_transaksi = 'Pengeluaran'
        OR (jenis_transaksi = 'Pindah Buku' AND rekening_sumber = ?)
      )
      AND tanggal BETWEEN ? AND ?
      AND (
        rekening_sumber = ? OR
        rekening_masuk = ?
      )
    GROUP BY kelompok, rutin`,
    [idRekening, startDate, endDate, idRekening, idRekening]
  );
}

/**
 * Reinitialize TRANSAKSI into Saldo Awal rows while preserving REKENING and unrealized harta=1 assets.
 */
export async function reinitialize() {
  const balances = await db.queryAll(
    `SELECT
      r.id,
      t.kelompok,
      r.nama,
      1 AS rutin,
      (
        IFNULL(
          SUM(
            CASE
              WHEN t.jenis_transaksi IN ('Pemasukan', 'Pindah Buku')
              AND t.rekening_masuk = r.id THEN (t.nominal * t.kuantitas)
              ELSE 0
            END
          ),
          0
        ) - IFNULL(
          SUM(
            CASE
              WHEN t.jenis_transaksi IN ('Pengeluaran', 'Pindah Buku')
              AND t.rekening_sumber = r.id THEN (t.nominal * t.kuantitas)
              ELSE 0
            END
          ),
          0
        )
      ) AS total,
      CASE
        WHEN r.nominal_asing IS NULL
        OR r.nominal_asing = '' THEN 0
        ELSE (
          IFNULL(
            SUM(
              CASE
                WHEN t.jenis_transaksi IN ('Pemasukan', 'Pindah Buku')
                AND t.rekening_masuk = r.id THEN (t.nominal_asing * t.kuantitas)
                ELSE 0
              END
            ),
            0
          ) - IFNULL(
            SUM(
              CASE
                WHEN t.jenis_transaksi IN ('Pengeluaran', 'Pindah Buku')
                AND t.rekening_sumber = r.id THEN (t.nominal_asing * t.kuantitas)
                ELSE 0
              END
            ),
            0
          )
        )
      END AS total_asing
    FROM REKENING r
    LEFT JOIN ${TABLE} t ON r.id = t.rekening_masuk OR r.id = t.rekening_sumber
    WHERE r.harta = 0 AND t.rutin = 1
    GROUP BY r.id, t.kelompok, r.nominal_asing

    UNION ALL

    SELECT
      r.id,
      NULL AS kelompok,
      r.nama,
      0 AS rutin,
      (
        IFNULL(
          SUM(
            CASE
              WHEN t.jenis_transaksi IN ('Pemasukan', 'Pindah Buku')
              AND t.rekening_masuk = r.id THEN (t.nominal * t.kuantitas)
              ELSE 0
            END
          ),
          0
        ) - IFNULL(
          SUM(
            CASE
              WHEN t.jenis_transaksi IN ('Pengeluaran', 'Pindah Buku')
              AND t.rekening_sumber = r.id THEN (t.nominal * t.kuantitas)
              ELSE 0
            END
          ),
          0
        )
      ) AS total,
      CASE
        WHEN r.nominal_asing IS NULL
        OR r.nominal_asing = '' THEN 0
        ELSE (
          IFNULL(
            SUM(
              CASE
                WHEN t.jenis_transaksi IN ('Pemasukan', 'Pindah Buku')
                AND t.rekening_masuk = r.id THEN (t.nominal_asing * t.kuantitas)
                ELSE 0
              END
            ),
            0
          ) - IFNULL(
            SUM(
              CASE
                WHEN t.jenis_transaksi IN ('Pengeluaran', 'Pindah Buku')
                AND t.rekening_sumber = r.id THEN (t.nominal_asing * t.kuantitas)
                ELSE 0
              END
            ),
            0
          )
        )
      END AS total_asing
    FROM REKENING r
    LEFT JOIN ${TABLE} t ON r.id = t.rekening_masuk OR r.id = t.rekening_sumber
    WHERE r.harta = 0 AND t.rutin = 0
    GROUP BY r.id, r.nominal_asing`
  );

  const hartaToKeep = await db.queryAll(
    `SELECT * FROM ${TABLE}
    WHERE harta = 1 AND jenis_transaksi = 'Pemasukan'
      AND id NOT IN (
        SELECT relasi_transaksi
        FROM ${TABLE}
        WHERE harta = 1 AND jenis_transaksi = 'Pengeluaran' AND relasi_transaksi IS NOT NULL
      )`
  );

  const hasSeqTable = await db.queryOne(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'"
  );

  const now = new Date();
  const today = formatLocalDate(now);
  const versionDate = formatLocalDateTime(now);
  const pad = (n) => String(n).padStart(2, '0');
  const fingerprint = `v2-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const ops = [
    { sql: `DELETE FROM ${TABLE}`, bind: [] },
    { sql: 'DELETE FROM DB_INFO', bind: [] }
  ];

  if (hasSeqTable) {
    ops.push({ sql: "DELETE FROM sqlite_sequence WHERE name = 'TRANSAKSI'", bind: [] });
  }

  ops.push({
    sql: 'INSERT INTO DB_INFO (version_date, fingerprint) VALUES (?, ?)',
    bind: [versionDate, fingerprint]
  });

  for (const b of balances) {
    const total = Number(b.total) || 0;
    const totalAsing = Number(b.total_asing) || 0;
    if (total === 0 && totalAsing === 0) continue;

    const isNegative = total < 0 || (total === 0 && totalAsing < 0);
    if (isNegative) {
      ops.push(
        buildInsertStatement({
          jenis_transaksi: 'Pengeluaran',
          barang: 'Saldo Awal (Hutang)',
          rekening_sumber: b.id,
          kelompok: b.kelompok ?? null,
          rutin: b.rutin,
          nominal: Math.abs(total),
          nominal_asing: Math.abs(totalAsing),
          kuantitas: 1,
          tanggal: today,
          keterangan: 'Reinitialization Saldo Awal (Hutang)'
        })
      );
    } else {
      ops.push(
        buildInsertStatement({
          jenis_transaksi: 'Pemasukan',
          barang: 'Saldo Awal',
          rekening_masuk: b.id,
          kelompok: b.kelompok ?? null,
          rutin: b.rutin,
          nominal: total,
          nominal_asing: totalAsing,
          kuantitas: 1,
          tanggal: today,
          keterangan: 'Reinitialization Saldo Awal'
        })
      );
    }
  }

  for (const h of hartaToKeep) {
    const copy = { ...h };
    delete copy.id;
    ops.push(buildInsertStatement(copy));
  }

  await db.transaction(ops);
  return true;
}
