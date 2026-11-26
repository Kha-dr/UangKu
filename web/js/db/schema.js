/**
 * SQLite schema definitions and versioned migrations for KasIn v2.
 * Uses `IF NOT EXISTS` guards so both fresh and imported `.sqlite` files work seamlessly.
 */

const REKENING_SALDO_VIEW_SQL = `CREATE VIEW IF NOT EXISTS REKENING_SALDO AS
SELECT
  r.*,
  IFNULL(SUM(t.saldo), 0) AS saldo,
  IFNULL(SUM(t.saldo_asing), 0) AS saldo_asing
FROM
  REKENING r
  LEFT JOIN (
    SELECT
      rekening_masuk AS rekening_id,
      (CASE WHEN harta = 1
        THEN MAX(1, (nominal - (penyusutan_bunga * CAST((julianday('now') - julianday(tanggal)) / 30.44 AS INTEGER))) * kuantitas)
        ELSE (nominal * kuantitas) END) AS saldo,
      (nominal_asing * kuantitas) AS saldo_asing
    FROM
      TRANSAKSI
    WHERE
      jenis_transaksi IN ('Pemasukan', 'Pindah Buku')
    UNION ALL
    SELECT
      rekening_sumber AS rekening_id,
      - (nominal * kuantitas) AS saldo,
      - (nominal_asing * kuantitas) AS saldo_asing
    FROM
      TRANSAKSI
    WHERE
      jenis_transaksi IN ('Pengeluaran', 'Pindah Buku')
  ) t ON r.id = t.rekening_id
GROUP BY
  r.id,
  r.nama;`;

const REKENING_MIGRATION_COLUMNS = [
  { name: 'hutang', definition: 'BOOLEAN NOT NULL DEFAULT 0' },
  { name: 'limit_kredit', definition: 'NUMERIC DEFAULT NULL' },
  { name: 'tgl_cetak_tagihan', definition: 'INTEGER DEFAULT NULL' },
  { name: 'tgl_jatuh_tempo', definition: 'INTEGER DEFAULT NULL' },
  { name: 'tenor_bulan', definition: 'INTEGER DEFAULT NULL' },
  { name: 'bunga_persen', definition: 'NUMERIC DEFAULT NULL' }
];

export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS REKENING (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL,
  no_asli TEXT,
  nominal_asing TEXT DEFAULT '',
  harta BOOLEAN NOT NULL DEFAULT FALSE,
  hutang BOOLEAN NOT NULL DEFAULT 0,
  limit_kredit NUMERIC DEFAULT NULL,
  tgl_cetak_tagihan INTEGER DEFAULT NULL,
  tgl_jatuh_tempo INTEGER DEFAULT NULL,
  tenor_bulan INTEGER DEFAULT NULL,
  bunga_persen NUMERIC DEFAULT NULL,
  tgl_dibuat TEXT,
  tgl_ditutup TEXT,
  aktif BOOLEAN NOT NULL,
  keterangan TEXT,
  jenis_uang TEXT NULL
);`,

  `CREATE TABLE IF NOT EXISTS TRANSAKSI (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jenis_transaksi TEXT,
  harta BOOLEAN NOT NULL DEFAULT FALSE,
  barang TEXT NOT NULL,
  rekening_sumber INTEGER,
  rekening_masuk INTEGER,
  nominal NUMERIC,
  nominal_asing NUMERIC,
  kuantitas NUMERIC,
  penyusutan_bunga NUMERIC,
  rutin BOOLEAN NOT NULL DEFAULT FALSE,
  kelompok TEXT,
  tanggal TEXT,
  relasi_transaksi INTEGER,
  attachment TEXT,
  keterangan TEXT,
  review TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);`,

  `CREATE TABLE IF NOT EXISTS WISHLIST (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL,
  harga_estimasi NUMERIC,
  link TEXT,
  catatan TEXT,
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT
);`,

  `CREATE TABLE IF NOT EXISTS DB_INFO (
  version_date TEXT,
  fingerprint TEXT
);`,

  REKENING_SALDO_VIEW_SQL,

  `CREATE INDEX IF NOT EXISTS idx_transaksi_rutin ON TRANSAKSI(rutin);`,
  `CREATE INDEX IF NOT EXISTS idx_transaksi_review ON TRANSAKSI(review);`,
  `CREATE INDEX IF NOT EXISTS idx_transaksi_keterangan ON TRANSAKSI(keterangan);`,
  `CREATE INDEX IF NOT EXISTS idx_transaksi_barang ON TRANSAKSI(barang);`,
  `CREATE INDEX IF NOT EXISTS idx_transaksi_kelompok ON TRANSAKSI(kelompok);`,
  `CREATE INDEX IF NOT EXISTS idx_transaksi_jenis ON TRANSAKSI(jenis_transaksi);`,
  `CREATE INDEX IF NOT EXISTS idx_transaksi_sumber ON TRANSAKSI(rekening_sumber);`,
  `CREATE INDEX IF NOT EXISTS idx_transaksi_masuk ON TRANSAKSI(rekening_masuk);`
];

export const SCHEMA_SQL = SCHEMA_STATEMENTS.join('\n\n');

export const LATEST_SCHEMA_VERSION = 2;

export function getUserVersion(db) {
  const rows = db.exec({
    sql: 'PRAGMA user_version',
    rowMode: 'object',
    returnValue: 'resultRows'
  });
  return rows && rows.length > 0 ? Number(rows[0].user_version || 0) : 0;
}

export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial_schema',
    up(db) {
      for (const stmt of SCHEMA_STATEMENTS) {
        db.exec(stmt);
      }
    }
  },
  {
    version: 2,
    name: 'rekening_cc_loan_columns',
    up(db) {
      const columns = db.exec({
        sql: 'PRAGMA table_info(REKENING)',
        rowMode: 'object',
        returnValue: 'resultRows'
      });
      const existingColumns = new Set((columns || []).map((col) => col.name));

      let addedColumn = false;
      for (const col of REKENING_MIGRATION_COLUMNS) {
        if (!existingColumns.has(col.name)) {
          db.exec(`ALTER TABLE REKENING ADD COLUMN ${col.name} ${col.definition};`);
          addedColumn = true;
        }
      }

      if (addedColumn) {
        db.exec('DROP VIEW IF EXISTS REKENING_SALDO;');
        db.exec(REKENING_SALDO_VIEW_SQL);
      }
    }
  }
];

/**
 * Execute pending schema migrations tracked via SQLite `PRAGMA user_version`.
 * Safe for fresh databases, v1/v2 imports, and future additive/alter migrations.
 * @param {{ exec: (sql: unknown) => unknown }} db
 */
export function initSchemaStatements(db) {
  const previousVersion = getUserVersion(db);

  if (previousVersion > LATEST_SCHEMA_VERSION) {
    console.warn(
      `Database schema version (${previousVersion}) is newer than supported (${LATEST_SCHEMA_VERSION}).`
    );
    return {
      previousVersion,
      currentVersion: previousVersion,
      applied: [],
      newerThanSupported: true
    };
  }

  const applied = [];
  for (const migration of MIGRATIONS) {
    if (migration.version <= previousVersion) continue;
    db.exec('BEGIN TRANSACTION;');
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version};`);
      db.exec('COMMIT;');
      applied.push(migration.version);
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // Ignore rollback error if transaction already aborted
      }
      throw new Error(`Migration v${migration.version} (${migration.name}) failed: ${err?.message || err}`);
    }
  }

  return {
    previousVersion,
    currentVersion: applied.length ? applied[applied.length - 1] : previousVersion,
    applied,
    newerThanSupported: false
  };
}

export const runMigrations = initSchemaStatements;
