declare module '*.wasm' {
  const mod: WebAssembly.Module;
  export default mod;
}

declare module 'sql.js' {
  export type SqlValue = number | string | Uint8Array | null;
  export type BindParams = SqlValue[] | Record<string, SqlValue>;

  export interface QueryExecResult {
    columns: string[];
    values: SqlValue[][];
  }

  export interface Statement {
    bind(values?: BindParams): boolean;
    step(): boolean;
    get(params?: BindParams): SqlValue[];
    getAsObject(params?: BindParams): Record<string, SqlValue>;
    free(): boolean;
    reset(): void;
  }

  export interface Database {
    exec(sql: string, params?: BindParams): QueryExecResult[];
    prepare(sql: string, params?: BindParams): Statement;
    run(sql: string, params?: BindParams): Database;
    getRowsModified(): number;
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJsConfig {
    instantiateWasm?: (
      imports: WebAssembly.Imports,
      receiveInstance: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void
    ) => WebAssembly.Exports;
    locateFile?: (file: string, prefix?: string) => string;
  }

  export interface SqlJsStatic {
    Database: {
      new (data?: ArrayLike<number> | Buffer | null): Database;
    };
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
