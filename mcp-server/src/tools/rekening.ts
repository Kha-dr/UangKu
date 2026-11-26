import { type Database } from 'sql.js';
import { queryAll, toNullableNumber, type McpToolDefinition } from './sqlite.js';

export function executeGetRekening(db: Database): unknown {
  const rows = queryAll(db, 'SELECT * FROM REKENING_SALDO');
  return {
    data: rows.map((r) => ({
      rekening_id: r.id,
      id: r.id,
      nama_rekening: r.nama,
      nama: r.nama,
      saldo: r.saldo ?? 0,
      saldo_asing: r.saldo_asing ?? 0,
      aktif: r.aktif !== undefined ? Boolean(r.aktif) : true,
      harta: r.harta !== undefined ? Boolean(r.harta) : false,
      hutang: r.hutang !== undefined && r.hutang !== null ? Boolean(r.hutang) : false,
      limit_kredit: toNullableNumber(r.limit_kredit),
      tgl_cetak_tagihan: toNullableNumber(r.tgl_cetak_tagihan),
      tgl_jatuh_tempo: toNullableNumber(r.tgl_jatuh_tempo),
      tenor_bulan: toNullableNumber(r.tenor_bulan),
      bunga_persen: toNullableNumber(r.bunga_persen),
      isAsing: Boolean(r.nominal_asing),
      nominal_asing: r.nominal_asing ?? null,
      jenis_uang: r.jenis_uang ?? null
    }))
  };
}

export function executeGetHarta(db: Database): unknown {
  const rows = queryAll(
    db,
    `SELECT
      r.nama AS nama_rekening,
      CAST((julianday('now') - julianday(t.tanggal)) / 30.44 AS INTEGER) AS bulan_berjalan,
      (t.penyusutan_bunga * CAST((julianday('now') - julianday(t.tanggal)) / 30.44 AS INTEGER)) AS total_penyusutan_per_unit,
      MAX(1,
        (t.nominal - (t.penyusutan_bunga * CAST((julianday('now') - julianday(t.tanggal)) / 30.44 AS INTEGER))) * t.kuantitas
      ) AS nilai_sekarang,
      t.*
    FROM TRANSAKSI t
    JOIN REKENING r ON t.rekening_masuk = r.id
    WHERE t.harta = 1
      AND t.jenis_transaksi = 'Pemasukan'
      AND t.id NOT IN (
        SELECT relasi_transaksi
        FROM TRANSAKSI
        WHERE harta = 1 AND jenis_transaksi = 'Pengeluaran' AND relasi_transaksi IS NOT NULL
      )`
  );
  return { data: rows };
}

export const REKENING_TOOLS: McpToolDefinition[] = [
  {
    name: 'get_rekening',
    description: `Mendapatkan daftar rekening aktif dan ID untuk input transaksi. WAJIB dipanggil fresh sebelum mencatat transaksi untuk mendapatkan ID rekening valid terkini (jangan gunakan ID dari ingatan/cache).
Format data: [rekening_id, nama_rekening, saldo, saldo_asing, aktif, harta, hutang, limit_kredit, tgl_cetak_tagihan, tgl_jatuh_tempo, tenor_bulan, bunga_persen, isAsing].`,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    },
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_harta',
    description:
      'Mendapatkan daftar transaksi harta/aset yang sudah tercatat dan nilai pembukuannya (aset permanen seperti HP, Kendaraan, Emas, Properti, Furnitur) untuk referensi inventaris dan depresiasi.',
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    },
    inputSchema: { type: 'object', properties: {} }
  }
];
