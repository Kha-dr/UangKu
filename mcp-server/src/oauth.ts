export interface OAuthEnv {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

interface EncodedOAuthState {
  r: string;
  s?: string;
}

function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(encoded: string): string {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((encoded.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

export function isValidRedirectUri(rawUri: string): boolean {
  try {
    const parsed = new URL(rawUri);
    if (parsed.protocol === 'https:') {
      return Boolean(parsed.hostname);
    }
    if (parsed.protocol === 'http:') {
      return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    }
    return false;
  } catch {
    return false;
  }
}

function jsonResponse(data: unknown, status = 200, corsHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders
    }
  });
}

export function handleProtectedResourceMetadata(
  origin: string,
  corsHeaders: Record<string, string> = {}
): Response {
  return jsonResponse(
    {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      scopes_supported: [DRIVE_APPDATA_SCOPE]
    },
    200,
    corsHeaders
  );
}

export function handleAuthorizationServerMetadata(
  origin: string,
  corsHeaders: Record<string, string> = {}
): Response {
  return jsonResponse(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256', 'plain'],
      scopes_supported: [DRIVE_APPDATA_SCOPE]
    },
    200,
    corsHeaders
  );
}

export async function handleOAuthRegister(
  request: Request,
  env: OAuthEnv,
  corsHeaders: Record<string, string> = {}
): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse(
      { error: 'invalid_client_metadata', error_description: 'Request body must be valid JSON.' },
      400,
      corsHeaders
    );
  }

  const rawRedirectUris = body.redirect_uris;
  if (!Array.isArray(rawRedirectUris) || rawRedirectUris.length === 0) {
    return jsonResponse(
      { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be a non-empty array.' },
      400,
      corsHeaders
    );
  }

  const redirectUris: string[] = [];
  for (const item of rawRedirectUris) {
    if (typeof item !== 'string' || !isValidRedirectUri(item)) {
      return jsonResponse(
        {
          error: 'invalid_redirect_uri',
          error_description: 'Every redirect_uri must use https:// or http://localhost / http://127.0.0.1.'
        },
        400,
        corsHeaders
      );
    }
    redirectUris.push(item);
  }

  const clientName = typeof body.client_name === 'string' ? body.client_name : 'KasIn MCP Client';

  return jsonResponse(
    {
      client_id: env.GOOGLE_CLIENT_ID || 'kasin-mcp-client',
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: DRIVE_APPDATA_SCOPE
    },
    201,
    corsHeaders
  );
}

export function handleOAuthAuthorize(
  request: Request,
  origin: string,
  env: OAuthEnv,
  corsHeaders: Record<string, string> = {}
): Response {
  if (!env.GOOGLE_CLIENT_ID) {
    return jsonResponse(
      { error: 'server_error', error_description: 'GOOGLE_CLIENT_ID secret is not configured.' },
      500,
      corsHeaders
    );
  }

  const url = new URL(request.url);
  const redirectUri = url.searchParams.get('redirect_uri') ?? '';
  if (!redirectUri || !isValidRedirectUri(redirectUri)) {
    return jsonResponse(
      {
        error: 'invalid_request',
        error_description: 'Invalid or missing redirect_uri. Must be https:// or http://localhost / http://127.0.0.1.'
      },
      400,
      corsHeaders
    );
  }

  const clientState = url.searchParams.get('state') ?? undefined;
  const encodedStatePayload: EncodedOAuthState = clientState
    ? { r: redirectUri, s: clientState }
    : { r: redirectUri };

  const googleParams = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/oauth/callback`,
    response_type: 'code',
    scope: DRIVE_APPDATA_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state: toBase64Url(JSON.stringify(encodedStatePayload))
  });

  const codeChallenge = url.searchParams.get('code_challenge');
  const codeChallengeMethod = url.searchParams.get('code_challenge_method');
  if (codeChallenge) {
    googleParams.set('code_challenge', codeChallenge);
    if (codeChallengeMethod) {
      googleParams.set('code_challenge_method', codeChallengeMethod);
    }
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${GOOGLE_AUTH_URL}?${googleParams.toString()}`,
      ...corsHeaders
    }
  });
}

export function handleOAuthCallback(
  request: Request,
  corsHeaders: Record<string, string> = {}
): Response {
  const url = new URL(request.url);
  const rawState = url.searchParams.get('state');
  if (!rawState) {
    return jsonResponse(
      { error: 'invalid_request', error_description: 'Missing state parameter.' },
      400,
      corsHeaders
    );
  }

  let parsedState: EncodedOAuthState;
  try {
    parsedState = JSON.parse(fromBase64Url(rawState)) as EncodedOAuthState;
  } catch {
    return jsonResponse(
      { error: 'invalid_request', error_description: 'Malformed state parameter.' },
      400,
      corsHeaders
    );
  }

  if (!parsedState?.r || !isValidRedirectUri(parsedState.r)) {
    return jsonResponse(
      { error: 'invalid_request', error_description: 'Invalid redirect_uri in state.' },
      400,
      corsHeaders
    );
  }

  const clientRedirect = new URL(parsedState.r);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const errorDescription = url.searchParams.get('error_description');

  if (code) {
    clientRedirect.searchParams.set('code', code);
  }
  if (error) {
    clientRedirect.searchParams.set('error', error);
  }
  if (errorDescription) {
    clientRedirect.searchParams.set('error_description', errorDescription);
  }
  if (parsedState.s !== undefined) {
    clientRedirect.searchParams.set('state', parsedState.s);
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: clientRedirect.toString(),
      ...corsHeaders
    }
  });
}

export async function handleOAuthToken(
  request: Request,
  origin: string,
  env: OAuthEnv,
  corsHeaders: Record<string, string> = {}
): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return jsonResponse(
      {
        error: 'server_error',
        error_description: 'GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET secret is not configured.'
      },
      500,
      corsHeaders
    );
  }

  let params: URLSearchParams;
  const contentType = request.headers.get('Content-Type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      const json = (await request.json()) as Record<string, string>;
      params = new URLSearchParams();
      for (const [k, v] of Object.entries(json)) {
        if (v !== undefined && v !== null) {
          params.set(k, String(v));
        }
      }
    } catch {
      return jsonResponse(
        { error: 'invalid_request', error_description: 'Invalid JSON body.' },
        400,
        corsHeaders
      );
    }
  } else {
    const rawBody = await request.text();
    params = new URLSearchParams(rawBody);
  }

  const grantType = params.get('grant_type');
  if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
    return jsonResponse(
      { error: 'unsupported_grant_type', error_description: 'Supported grant_types: authorization_code, refresh_token.' },
      400,
      corsHeaders
    );
  }

  const tokenParams = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    grant_type: grantType
  });

  if (grantType === 'authorization_code') {
    const code = params.get('code');
    if (!code) {
      return jsonResponse(
        { error: 'invalid_request', error_description: 'Missing authorization code.' },
        400,
        corsHeaders
      );
    }
    tokenParams.set('code', code);
    tokenParams.set('redirect_uri', `${origin}/oauth/callback`);

    const codeVerifier = params.get('code_verifier');
    if (codeVerifier) {
      tokenParams.set('code_verifier', codeVerifier);
    }
  } else {
    const refreshToken = params.get('refresh_token');
    if (!refreshToken) {
      return jsonResponse(
        { error: 'invalid_request', error_description: 'Missing refresh_token.' },
        400,
        corsHeaders
      );
    }
    tokenParams.set('refresh_token', refreshToken);
  }

  const googleResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: tokenParams.toString()
  });

  const payload = await googleResponse.text();
  return new Response(payload, {
    status: googleResponse.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders
    }
  });
}
