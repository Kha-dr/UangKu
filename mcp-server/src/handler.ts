import { ConflictError, UnauthorizedError } from './gdrive.js';
import {
  handleAuthorizationServerMetadata,
  handleOAuthAuthorize,
  handleOAuthCallback,
  handleOAuthRegister,
  handleOAuthToken,
  handleProtectedResourceMetadata,
  type OAuthEnv
} from './oauth.js';
import {
  callMcpTool,
  MCP_PROMPTS,
  MCP_RESOURCES,
  MCP_TOOLS,
  SYSTEM_PROMPT_TEXT
} from './tools.js';

export interface Env extends OAuthEnv {}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
  'Access-Control-Max-Age': '86400'
};

function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders
    }
  });
}

function jsonRpcResult(
  id: string | number | null | undefined,
  result: unknown
): Response {
  return jsonResponse({
    jsonrpc: '2.0',
    id: id ?? null,
    result
  });
}

function jsonRpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  status = 200
): Response {
  return jsonResponse(
    {
      jsonrpc: '2.0',
      id: id ?? null,
      error: {
        code,
        message
      }
    },
    status
  );
}

function unauthorizedResponse(origin: string, message = 'Unauthorized'): Response {
  return jsonResponse(
    {
      error: 'unauthorized',
      error_description: message
    },
    401,
    {
      'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
    }
  );
}

function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

async function handleMcpRequest(request: Request, origin: string): Promise<Response> {
  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, -32700, 'Parse error: invalid JSON.', 400);
  }

  if (!body || typeof body !== 'object' || body.jsonrpc !== '2.0' || !body.method) {
    return jsonRpcError(body?.id, -32600, 'Invalid Request: expected JSON-RPC 2.0 object.', 400);
  }

  const { id, method, params = {} } = body;

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return new Response(null, {
      status: 202,
      headers: CORS_HEADERS
    });
  }

  switch (method) {
    case 'initialize': {
      const protocolVersion =
        typeof params.protocolVersion === 'string' && params.protocolVersion
          ? params.protocolVersion
          : '2025-03-26';
      return jsonRpcResult(id, {
        protocolVersion,
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
          prompts: { listChanged: false }
        },
        serverInfo: {
          name: 'kasin-mcp-server',
          version: '2.0.0'
        }
      });
    }

    case 'ping': {
      return jsonRpcResult(id, {});
    }

    case 'tools/list': {
      return jsonRpcResult(id, {
        tools: MCP_TOOLS
      });
    }

    case 'tools/call': {
      const accessToken = extractBearerToken(request);
      if (!accessToken) {
        return unauthorizedResponse(origin, 'Bearer access token is required to call KasIn tools.');
      }

      const toolName = typeof params.name === 'string' ? params.name : '';
      const toolArgs =
        params.arguments && typeof params.arguments === 'object'
          ? (params.arguments as Record<string, unknown>)
          : {};

      if (!toolName) {
        return jsonRpcError(id, -32602, 'Invalid params: tool name is required.');
      }

      try {
        const result = await callMcpTool(toolName, toolArgs, accessToken);
        const isError =
          typeof result === 'object' &&
          result !== null &&
          (result as { success?: boolean }).success === false;

        return jsonRpcResult(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result)
            }
          ],
          isError
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          return unauthorizedResponse(origin, err.message);
        }
        if (err instanceof ConflictError) {
          return jsonRpcResult(id, {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success: false, error: err.message, conflict: true })
              }
            ],
            isError: true
          });
        }
        const message = err instanceof Error ? err.message : String(err);
        return jsonRpcResult(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: false, error: message })
            }
          ],
          isError: true
        });
      }
    }

    case 'resources/list': {
      return jsonRpcResult(id, {
        resources: MCP_RESOURCES
      });
    }

    case 'resources/read': {
      const uri = typeof params.uri === 'string' ? params.uri : '';
      if (uri !== 'kasin://system_prompt') {
        return jsonRpcError(id, -32602, `Resource not found: ${uri}`);
      }
      return jsonRpcResult(id, {
        contents: [
          {
            uri: 'kasin://system_prompt',
            mimeType: 'text/plain',
            text: SYSTEM_PROMPT_TEXT
          }
        ]
      });
    }

    case 'prompts/list': {
      return jsonRpcResult(id, {
        prompts: MCP_PROMPTS
      });
    }

    case 'prompts/get': {
      const name = typeof params.name === 'string' ? params.name : '';
      if (name !== 'Transaksi') {
        return jsonRpcError(id, -32602, `Prompt not found: ${name}`);
      }
      return jsonRpcResult(id, {
        description: 'Panduan lengkap AI Assistant untuk mencatat transaksi KasIn.',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: SYSTEM_PROMPT_TEXT
            }
          }
        ]
      });
    }

    default: {
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
  }
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }

  const url = new URL(request.url);
  const origin = url.origin;
  const path = url.pathname;

  if (request.method === 'GET' && path === '/health') {
    return jsonResponse({
      status: 'ok',
      service: 'kasin-mcp-server',
      stateless: true
    });
  }

  if (
    request.method === 'GET' &&
    (path === '/.well-known/oauth-protected-resource' ||
      path === '/.well-known/oauth-protected-resource/mcp')
  ) {
    return handleProtectedResourceMetadata(origin, CORS_HEADERS);
  }

  if (
    request.method === 'GET' &&
    (path === '/.well-known/oauth-authorization-server' ||
      path === '/.well-known/oauth-authorization-server/mcp')
  ) {
    return handleAuthorizationServerMetadata(origin, CORS_HEADERS);
  }

  if (request.method === 'POST' && path === '/oauth/register') {
    return handleOAuthRegister(request, env, CORS_HEADERS);
  }

  if (request.method === 'GET' && path === '/oauth/authorize') {
    return handleOAuthAuthorize(request, origin, env, CORS_HEADERS);
  }

  if (request.method === 'GET' && path === '/oauth/callback') {
    return handleOAuthCallback(request, CORS_HEADERS);
  }

  if (request.method === 'POST' && path === '/oauth/token') {
    return handleOAuthToken(request, origin, env, CORS_HEADERS);
  }

  if (path === '/mcp') {
    if (request.method === 'POST') {
      return handleMcpRequest(request, origin);
    }
    return jsonResponse(
      { error: 'method_not_allowed', error_description: 'Use POST /mcp for JSON-RPC 2.0 requests.' },
      405,
      { Allow: 'POST, OPTIONS' }
    );
  }

  return jsonResponse({ error: 'not_found' }, 404);
}
