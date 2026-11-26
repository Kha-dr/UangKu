import { db } from '../db/client.js';

const TABLE = 'REKENING';
const VIEW = 'REKENING_SALDO';

const ALLOWED_COLUMNS = [
  'nama',
  'no_asli',
  'nominal_asing',
  'harta',
  'hutang',
  'limit_kredit',
  'tgl_cetak_tagihan',
  'tgl_jatuh_tempo',
  'tenor_bulan',
  'bunga_persen',
  'tgl_dibuat',
  'tgl_ditutup',
  'aktif',
  'keterangan',
  'jenis_uang'
];

const BOOLEAN_COLUMNS = new Set(['harta', 'hutang', 'aktif']);

function normalizeColumnValue(col, value) {
  if (BOOLEAN_COLUMNS.has(col)) {
    return value ? 1 : 0;
  }
  return value === undefined ? null : value;
}

function normalizeRekeningRow(row) {
  return {
    ...row,
    aktif: row.aktif !== undefined ? Boolean(row.aktif) : true,
    harta: row.harta !== undefined ? Boolean(row.harta) : false,
    hutang: Boolean(row.hutang),
    isAsing: Boolean(row.nominal_asing)
  };
}

/**
 * Fetch a single account from REKENING_SALDO by ID.
 * @param {string|number} id
 */
export async function getById(id) {
  const row = await db.queryOne(`SELECT * FROM ${VIEW} WHERE id = ?`, [id]);
  if (!row) return null;
  return normalizeRekeningRow(row);
}

/**
 * Fetch all accounts from REKENING_SALDO with normalized booleans.
 */
export async function getAll() {
  const rows = await db.queryAll(`SELECT * FROM ${VIEW}`);
  return rows.map(normalizeRekeningRow);
}

/**
 * Compute schema-free account balance summary from REKENING_SALDO.
 */
export async function getSaldoSummary() {
  const row = await db.queryOne(
    `SELECT
      IFNULL(SUM(CASE WHEN harta = 0 AND IFNULL(hutang, 0) = 0 THEN saldo ELSE 0 END), 0) AS liquid_cash,
      IFNULL(SUM(CASE WHEN IFNULL(hutang, 0) = 1 THEN saldo ELSE 0 END), 0) AS total_debt,
      IFNULL(SUM(CASE WHEN harta = 1 THEN saldo ELSE 0 END), 0) AS total_harta
    FROM ${VIEW}`
  );

  const liquidCash = Number(row?.liquid_cash ?? 0);
  const totalDebt = Number(row?.total_debt ?? 0);
  const totalHarta = Number(row?.total_harta ?? 0);

  return {
    liquid_cash: liquidCash,
    total_debt: totalDebt,
    total_harta: totalHarta,
    net_liquid: liquidCash + totalDebt,
    net_worth: liquidCash + totalHarta + totalDebt
  };
}

export async function getSaldoEfektif() {
  return db.queryOne(
    `SELECT
      SUM(CASE WHEN jenis_transaksi = 'Pemasukan' THEN nominal * kuantitas ELSE 0 END) -
      SUM(CASE WHEN jenis_transaksi = 'Pengeluaran' THEN nominal * kuantitas ELSE 0 END) AS saldo
    FROM TRANSAKSI
    WHERE harta = 0`
  );
}

export async function getSaldoByJenisUang() {
  return db.queryAll(
    `SELECT
      r.jenis_uang,
      SUM(CASE WHEN t.jenis_transaksi = 'Pemasukan' THEN t.nominal * t.kuantitas
           WHEN t.jenis_transaksi = 'Pindah Buku' AND t.rekening_masuk = r.id THEN t.nominal * t.kuantitas ELSE 0 END) -
      SUM(CASE WHEN t.jenis_transaksi = 'Pengeluaran' THEN t.nominal * t.kuantitas
           WHEN t.jenis_transaksi = 'Pindah Buku' AND t.rekening_sumber = r.id THEN t.nominal * t.kuantitas ELSE 0 END) AS saldo
    FROM TRANSAKSI t
    JOIN REKENING r ON (t.rekening_masuk = r.id OR t.rekening_sumber = r.id)
    WHERE t.harta = 0
      AND IFNULL(r.hutang, 0) = 0
    GROUP BY r.jenis_uang`
  );
}

export async function getSaldoRekening(id) {
  return db.queryOne(
    `SELECT
      r.id,
      r.nama,
      (
        SUM(CASE WHEN t.jenis_transaksi = 'Pemasukan' AND t.rekening_masuk = r.id THEN t.nominal * t.kuantitas ELSE 0 END) +
        SUM(CASE WHEN t.jenis_transaksi = 'Pindah Buku' AND t.rekening_masuk = r.id THEN t.nominal * t.kuantitas ELSE 0 END)
      ) -
      (
        SUM(CASE WHEN t.jenis_transaksi = 'Pengeluaran' AND t.rekening_sumber = r.id THEN t.nominal * t.kuantitas ELSE 0 END) +
        SUM(CASE WHEN t.jenis_transaksi = 'Pindah Buku' AND t.rekening_sumber = r.id THEN t.nominal * t.kuantitas ELSE 0 END)
      ) AS saldo
    FROM REKENING r
    LEFT JOIN TRANSAKSI t ON (t.rekening_masuk = r.id OR t.rekening_sumber = r.id)
    WHERE r.id = ?
    GROUP BY r.id, r.nama`,
    [id]
  );
}

export async function getSaldoHarta(id) {
  return db.queryOne(
    `SELECT
      r.id,
      r.nama,
      SUM(MAX(1,
        (t.nominal - (t.penyusutan_bunga * CAST((julianday('now') - julianday(t.tanggal)) / 30.44 AS INTEGER))) * t.kuantitas
      )) AS saldo
    FROM REKENING r
    LEFT JOIN TRANSAKSI t ON t.rekening_masuk = r.id
    WHERE t.harta = 1
      AND r.id = ?
      AND t.jenis_transaksi = 'Pemasukan'
      AND t.id NOT IN (
        SELECT relasi_transaksi
        FROM TRANSAKSI
        WHERE harta = 1 AND jenis_transaksi = 'Pengeluaran' AND relasi_transaksi IS NOT NULL
      )
    GROUP BY r.id, r.nama`,
    [id]
  );
}

export async function insertRekening(data) {
  const cols = [];
  const placeholders = [];
  const bind = [];

  for (const col of ALLOWED_COLUMNS) {
    if (Object.hasOwn(data, col) && data[col] !== undefined) {
      cols.push(col);
      placeholders.push('?');
      bind.push(normalizeColumnValue(col, data[col]));
    }
  }

  if (cols.length === 0) {
    throw new Error('No valid columns provided for REKENING insert.');
  }

  const res = await db.run(
    `INSERT INTO ${TABLE} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
    bind
  );
  return {
    id: res.lastInsertRowid,
    changes: res.changes
  };
}

export async function updateRekening(id, data = {}) {
  const assignments = [];
  const bind = [];

  for (const col of ALLOWED_COLUMNS) {
    if (Object.hasOwn(data, col) && data[col] !== undefined) {
      assignments.push(`${col} = ?`);
      bind.push(normalizeColumnValue(col, data[col]));
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

export async function deleteRekening(id) {
  const res = await db.run(`DELETE FROM ${TABLE} WHERE id = ?`, [id]);
  return { changes: res.changes };
}

export async function allCashFlowGraph(startDate, endDate) {
  return db.queryAll(
    `WITH saldo_dasar AS (
      SELECT
        tanggal,
        SUM(CASE
              WHEN jenis_transaksi = 'Pemasukan' THEN nominal * kuantitas
              WHEN jenis_transaksi = 'Pengeluaran' THEN -nominal * kuantitas
              ELSE 0
            END) AS nilai
      FROM TRANSAKSI
      WHERE tanggal <= ?
        AND jenis_transaksi IN ('Pemasukan', 'Pengeluaran')
        AND harta = 0
      GROUP BY tanggal
    ),
    saldo_berjalan AS (
      SELECT
        tanggal,
        SUM(nilai) OVER (
          ORDER BY tanggal
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS saldo
      FROM saldo_dasar
    )
    SELECT *
    FROM saldo_berjalan
    WHERE tanggal BETWEEN ? AND ?
    ORDER BY tanggal`,
    [endDate, startDate, endDate]
  );
}

export async function rangeFlowGraph(startDate, endDate) {
  return db.queryAll(
    `WITH saldo_dasar AS (
      SELECT
        tanggal,
        SUM(CASE
              WHEN jenis_transaksi = 'Pemasukan' THEN nominal * kuantitas
              WHEN jenis_transaksi = 'Pengeluaran' THEN -nominal * kuantitas
              ELSE 0
            END) AS nilai
      FROM TRANSAKSI
      WHERE tanggal BETWEEN ? AND ?
        AND jenis_transaksi IN ('Pemasukan', 'Pengeluaran')
        AND harta = 0
      GROUP BY tanggal
    ),
    saldo_berjalan AS (
      SELECT
        tanggal,
        SUM(nilai) OVER (
          ORDER BY tanggal
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS saldo
      FROM saldo_dasar
    )
    SELECT *
    FROM saldo_berjalan
    WHERE tanggal BETWEEN ? AND ?
    ORDER BY tanggal`,
    [startDate, endDate, startDate, endDate]
  );
}

export async function rekeningAllCashFlowGraph(startDate, endDate, idRekening = null) {
  return db.queryAll(
    `WITH saldo_dasar AS (
      SELECT
        tanggal,
        SUM(CASE
              WHEN jenis_transaksi = 'Pemasukan' THEN nominal * kuantitas
              WHEN jenis_transaksi = 'Pengeluaran' THEN -nominal * kuantitas
              WHEN jenis_transaksi = 'Pindah Buku' AND rekening_masuk = ? THEN nominal * kuantitas
              WHEN jenis_transaksi = 'Pindah Buku' AND rekening_sumber = ? THEN -nominal * kuantitas
              ELSE 0
            END) AS nilai
      FROM TRANSAKSI
      WHERE tanggal <= ?
        AND (
          rekening_sumber = ? OR
          rekening_masuk = ? OR
          ? IS NULL
        )
      GROUP BY tanggal
    ),
    saldo_berjalan AS (
      SELECT
        tanggal,
        SUM(nilai) OVER (
          ORDER BY tanggal
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS saldo
      FROM saldo_dasar
    )
    SELECT *
    FROM saldo_berjalan
    WHERE tanggal BETWEEN ? AND ?
    ORDER BY tanggal`,
    [
      idRekening,
      idRekening,
      endDate,
      idRekening,
      idRekening,
      idRekening,
      startDate,
      endDate
    ]
  );
}

export async function cashFlowGraph(startDate, endDate) {
  return db.queryAll(
    `WITH arus_kas AS (
      SELECT
        tanggal,
        rekening,
        SUM(perubahan) AS arus_kas,
        SUM(perubahan_asing) AS arus_kas_asing
      FROM (
        SELECT tanggal, rekening_masuk AS rekening, nominal * kuantitas AS perubahan, nominal_asing * kuantitas AS perubahan_asing
        FROM TRANSAKSI
        WHERE jenis_transaksi = 'Pemasukan' AND tanggal <= ? AND harta = 0

        UNION ALL

        SELECT tanggal, rekening_sumber AS rekening, -nominal * kuantitas AS perubahan, -nominal_asing * kuantitas AS perubahan_asing
        FROM TRANSAKSI
        WHERE jenis_transaksi = 'Pengeluaran' AND tanggal <= ? AND harta = 0

        UNION ALL

        SELECT tanggal, rekening_sumber AS rekening, -nominal * kuantitas AS perubahan, -nominal_asing * kuantitas AS perubahan_asing
        FROM TRANSAKSI
        WHERE jenis_transaksi = 'Pindah Buku' AND tanggal <= ? AND harta = 0

        UNION ALL

        SELECT tanggal, rekening_masuk AS rekening, nominal * kuantitas AS perubahan, nominal_asing * kuantitas AS perubahan_asing
        FROM TRANSAKSI
        WHERE jenis_transaksi = 'Pindah Buku' AND tanggal <= ? AND harta = 0
      )
      GROUP BY tanggal, rekening
    ),
    running_saldo AS (
      SELECT
        tanggal,
        rekening,
        SUM(arus_kas) OVER (
          PARTITION BY rekening
          ORDER BY tanggal
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS saldo,
        SUM(arus_kas_asing) OVER (
          PARTITION BY rekening
          ORDER BY tanggal
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS saldo_asing
      FROM arus_kas
    )
    SELECT *
    FROM ${VIEW}
    LEFT JOIN running_saldo ON running_saldo.rekening = ${VIEW}.id
    WHERE tanggal BETWEEN ? AND ?
    ORDER BY rekening, tanggal`,
    [endDate, endDate, endDate, endDate, startDate, endDate]
  );
}
