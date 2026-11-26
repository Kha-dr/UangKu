import { db } from '../db/client.js';

const TABLE = 'WISHLIST';

const ALLOWED_INSERT_COLUMNS = [
  'nama',
  'harga_estimasi',
  'link',
  'catatan',
  'created_at',
  'updated_at'
];

const ALLOWED_UPDATE_COLUMNS = [
  'nama',
  'harga_estimasi',
  'link',
  'catatan'
];

function formatLocalDateTime(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export async function getById(id) {
  return db.queryOne(`SELECT * FROM ${TABLE} WHERE id = ?`, [id]);
}

export async function getAll() {
  return db.queryAll(`SELECT * FROM ${TABLE} ORDER BY created_at DESC`);
}

export async function insertWishlist(data) {
  const cols = [];
  const placeholders = [];
  const bind = [];

  for (const col of ALLOWED_INSERT_COLUMNS) {
    if (Object.hasOwn(data, col) && data[col] !== undefined) {
      cols.push(col);
      placeholders.push('?');
      bind.push(data[col]);
    }
  }

  if (cols.length === 0) {
    throw new Error('No valid columns provided for WISHLIST insert.');
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

export async function updateWishlist(id, data = {}) {
  const assignments = [];
  const bind = [];

  for (const col of ALLOWED_UPDATE_COLUMNS) {
    if (Object.hasOwn(data, col) && data[col] !== undefined) {
      assignments.push(`${col} = ?`);
      bind.push(data[col]);
    }
  }

  if (assignments.length === 0) {
    return { changes: 0 };
  }

  assignments.push('updated_at = ?');
  bind.push(formatLocalDateTime());
  bind.push(id);

  const res = await db.run(
    `UPDATE ${TABLE} SET ${assignments.join(', ')} WHERE id = ?`,
    bind
  );
  return { changes: res.changes };
}

export async function deleteWishlist(id) {
  const res = await db.run(`DELETE FROM ${TABLE} WHERE id = ?`, [id]);
  return { changes: res.changes };
}
