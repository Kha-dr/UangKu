import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from 'sql.js';
import { type DeltaOp, type LoadedDelta } from '../gdrive.js';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MutatingToolOutcome {
  result: unknown;
  ops: DeltaOp[];
}

let sqlPromise: Promise<SqlJsStatic> | null = null;
let wasmModule: WebAssembly.Module | null = null;

export function setSqlWasmModule(mod: WebAssembly.Module): void {
  wasmModule = mod;
}

export function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    if (wasmModule) {
      const mod = wasmModule;
      sqlPromise = initSqlJs({
        instantiateWasm(imports, receiveInstance) {
          const instance = new WebAssembly.Instance(mod, imports);
          receiveInstance(instance, mod);
          return instance.exports;
        }
      });
    } else {
      sqlPromise = initSqlJs();
    }
  }
  return sqlPromise;
}

export function queryAll(
  db: Database,
  sql: string,
  params: SqlValue[] = []
): Record<string, SqlValue>[] {
  const stmt = db.prepare(sql);
  try {
    if (params.length > 0) {
      stmt.bind(params);
    }
    const rows: Record<string, SqlValue>[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    return rows;
  } finally {
    stmt.free();
  }
}

export function runStmt(
  db: Database,
  sql: string,
  params: SqlValue[] = []
): { lastInsertRowid: number; changes: number } {
  db.run(sql, params);
  const res = db.exec('SELECT last_insert_rowid() AS id, changes() AS changes');
  const row = res[0]?.values?.[0];
  return {
    lastInsertRowid: Number(row?.[0] ?? 0),
    changes: Number(row?.[1] ?? 0)
  };
}

function normalizeReplayBindValue(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string') return value;
  return String(value);
}

export function replayDeltas(db: Database, deltas: LoadedDelta[]): void {
  for (const delta of deltas) {
    const ops = delta.payload?.ops;
    if (!Array.isArray(ops) || ops.length === 0) {
      continue;
    }

    db.run('BEGIN IMMEDIATE');
    try {
      const results: Array<{ lastInsertRowid: number; changes: number }> = [];
      for (const op of ops) {
        const bind: SqlValue[] = Array.isArray(op.bind)
          ? op.bind.map(normalizeReplayBindValue)
          : [];
        if (
          Number.isInteger(op.relasiRefIndex) &&
          Number.isInteger(op.relasiParamIndex) &&
          (op.relasiParamIndex as number) >= 0
        ) {
          const target = results[op.relasiRefIndex as number];
          if (!target) {
            throw new Error(`Invalid relative row reference at index ${results.length}`);
          }
          bind[op.relasiParamIndex as number] = target.lastInsertRowid;
        }
        results.push(runStmt(db, op.sql, bind));
      }
      db.run('COMMIT');
    } catch (err) {
      try {
        db.run('ROLLBACK');
      } catch {
        // Ignore rollback errors if transaction was already aborted
      }
      throw err;
    }
  }
}

export function formatDBDate(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatLocalDateTime(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${formatDBDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function toNullableNumber(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}
