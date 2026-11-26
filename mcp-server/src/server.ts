import { handleRequest, type Env } from './handler.js';

declare const process: { env: Record<string, string | undefined> };
declare const Bun: {
  serve(options: {
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
  }): { port: number };
};

const rawPort = Number(process.env.PORT);
const port = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 8787;

const env: Env = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? ''
};

Bun.serve({
  port,
  fetch: (request: Request) => handleRequest(request, env)
});

console.log(
  `KasIn MCP server listening on port ${port} ` +
    `(GOOGLE_CLIENT_ID=${env.GOOGLE_CLIENT_ID ? 'configured' : 'missing'}, ` +
    `GOOGLE_CLIENT_SECRET=${env.GOOGLE_CLIENT_SECRET ? 'configured' : 'missing'})`
);
