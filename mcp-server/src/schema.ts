import type { Database } from 'sql.js';

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

const REKENING_MIGRATION_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: 'hutang', ddl: 'hutang BOOLEAN NOT NULL DEFAULT 0' },
  { name: 'limit_kredit', ddl: 'limit_kredit NUMERIC DEFAULT NULL' },
  { name: 'tgl_cetak_tagihan', ddl: 'tgl_cetak_tagihan INTEGER DEFAULT NULL' },
  { name: 'tgl_jatuh_tempo', ddl: 'tgl_jatuh_tempo INTEGER DEFAULT NULL' },
  { name: 'tenor_bulan', ddl: 'tenor_bulan INTEGER DEFAULT NULL' },
  { name: 'bunga_persen', ddl: 'bunga_persen NUMERIC DEFAULT NULL' }
];

/**
 * SQLite schema definitions for KasIn v2.
 * 1:1 parity with `web/js/db/schema.js`.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS REKENING (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL,
  no_asli TEXT,
  nominal_asing TEXT DEFAULT '',
  harta BOOLEAN NOT NULL DEFAULT FALSE,
  tgl_dibuat TEXT,
  tgl_ditutup TEXT,
  aktif BOOLEAN NOT NULL,
  keterangan TEXT,
  jenis_uang TEXT NULL,
  hutang BOOLEAN NOT NULL DEFAULT 0,
  limit_kredit NUMERIC DEFAULT NULL,
  tgl_cetak_tagihan INTEGER DEFAULT NULL,
  tgl_jatuh_tempo INTEGER DEFAULT NULL,
  tenor_bulan INTEGER DEFAULT NULL,
  bunga_persen NUMERIC DEFAULT NULL
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

export interface SchemaMigration {
  version: number;
  name: string;
  up(db: Database): void;
}

export interface MigrationResult {
  previousVersion: number;
  currentVersion: number;
  applied: number[];
  newerThanSupported: boolean;
}

export function getUserVersion(db: Database): number {
  const res = db.exec('PRAGMA user_version');
  if (res.length > 0 && res[0].values.length > 0) {
    return Number(res[0].values[0][0] || 0);
  }
  return 0;
}

export const MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up(db: Database): void {
      for (const stmt of SCHEMA_STATEMENTS) {
        db.exec(stmt);
      }
    }
  },
  {
    version: 2,
    name: 'rekening_cc_loan_columns',
    up(db: Database): void {
      const pragmaResult = db.exec('PRAGMA table_info(REKENING)');
      const existingCols = new Set<string>();
      if (pragmaResult.length > 0) {
        const nameColIdx = pragmaResult[0].columns.indexOf('name');
        const idx = nameColIdx >= 0 ? nameColIdx : 1;
        for (const row of pragmaResult[0].values) {
          if (row[idx] !== null && row[idx] !== undefined) {
            existingCols.add(String(row[idx]));
          }
        }
      }

      let addedColumn = false;
      for (const col of REKENING_MIGRATION_COLUMNS) {
        if (!existingCols.has(col.name)) {
          db.exec(`ALTER TABLE REKENING ADD COLUMN ${col.ddl};`);
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
 */
export function initSchemaStatements(db: Database): MigrationResult {
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

  const applied: number[] = [];
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
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Migration v${migration.version} (${migration.name}) failed: ${message}`);
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
