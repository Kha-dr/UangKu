import sqlWasm from '../node_modules/sql.js/dist/sql-wasm.wasm';
import { setSqlWasmModule } from './tools.js';
import { handleRequest, type Env } from './handler.js';

setSqlWasmModule(sqlWasm);

export type { Env };

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  }
};
