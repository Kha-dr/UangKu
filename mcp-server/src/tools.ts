import {
  COMPACT_THRESHOLD,
  compactSnapshotToDrive,
  loadSqliteWithDeltas,
  uploadDeltaFile,
  type DeltaOp
} from './gdrive.js';
import { initSchemaStatements } from './schema.js';
import { MCP_PROMPTS, MCP_RESOURCES, SYSTEM_PROMPT_TEXT } from './tools/prompt.js';
import {
  executeGetHarta,
  executeGetRekening,
  REKENING_TOOLS
} from './tools/rekening.js';
import {
  getSqlJs,
  replayDeltas,
  setSqlWasmModule,
  type McpToolDefinition
} from './tools/sqlite.js';
import {
  executeCatatTransaksi,
  executeGetKelompok,
  executeGetTransaksi,
  executeUpdateTransaksi,
  TRANSAKSI_TOOLS
} from './tools/transaksi.js';
import {
  executeAddWishlist,
  executeDeleteWishlist,
  executeListWishlist,
  executeUpdateWishlist,
  WISHLIST_TOOLS
} from './tools/wishlist.js';

export { MCP_PROMPTS, MCP_RESOURCES, SYSTEM_PROMPT_TEXT };
export { setSqlWasmModule, type McpToolDefinition };

const MUTATING_TOOLS = new Set([
  'catat_transaksi',
  'update_transaksi',
  'add_wishlist',
  'update_wishlist',
  'delete_wishlist'
]);

export const MCP_TOOLS: McpToolDefinition[] = [
  ...TRANSAKSI_TOOLS,
  ...REKENING_TOOLS,
  ...WISHLIST_TOOLS
];

export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const knownTool = MCP_TOOLS.some((t) => t.name === toolName);
  if (!knownTool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const SQL = await getSqlJs();
  const loaded = await loadSqliteWithDeltas(accessToken);
  const db = loaded.snapshot.bytes ? new SQL.Database(loaded.snapshot.bytes) : new SQL.Database();

  try {
    initSchemaStatements(db);
    replayDeltas(db, loaded.deltas);

    let result: unknown;
    let ops: DeltaOp[] = [];
    switch (toolName) {
      case 'catat_transaksi': {
        const outcome = executeCatatTransaksi(db, args);
        result = outcome.result;
        ops = outcome.ops;
        break;
      }
      case 'get_transaksi':
        result = executeGetTransaksi(db, args);
        break;
      case 'update_transaksi': {
        const outcome = executeUpdateTransaksi(db, args);
        result = outcome.result;
        ops = outcome.ops;
        break;
      }
      case 'get_rekening':
        result = executeGetRekening(db);
        break;
      case 'get_kelompok':
        result = executeGetKelompok(db);
        break;
      case 'get_harta':
        result = executeGetHarta(db);
        break;
      case 'list_wishlist':
        result = executeListWishlist(db);
        break;
      case 'add_wishlist': {
        const outcome = executeAddWishlist(db, args);
        result = outcome.result;
        ops = outcome.ops;
        break;
      }
      case 'update_wishlist': {
        const outcome = executeUpdateWishlist(db, args);
        result = outcome.result;
        ops = outcome.ops;
        break;
      }
      case 'delete_wishlist': {
        const outcome = executeDeleteWishlist(db, args);
        result = outcome.result;
        ops = outcome.ops;
        break;
      }
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }

    if (
      MUTATING_TOOLS.has(toolName) &&
      typeof result === 'object' &&
      result !== null &&
      (result as { success?: boolean }).success === true &&
      ops.length > 0
    ) {
      const uploadedDelta = await uploadDeltaFile(accessToken, ops);
      if (loaded.deltas.length + 1 >= COMPACT_THRESHOLD) {
        const deltaFileIds = [...loaded.deltas.map((d) => d.fileId), uploadedDelta.fileId];
        await compactSnapshotToDrive(
          accessToken,
          db.export(),
          loaded.snapshot.fileId,
          deltaFileIds
        );
      }
    }

    return result;
  } finally {
    db.close();
  }
}
