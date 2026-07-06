// MCP OAuth protocol primitives.
//
// Implements the MCP authorization spec building blocks against a remote
// server: protected-resource metadata discovery, authorization-server
// metadata discovery, dynamic client registration (RFC 7591), PKCE pair
// creation (RFC 7636, S256 only), the authorize-URL shape, and the
// authorization-code / refresh-token exchanges (RFC 8707 `resource`
// included when known). No storage and no window navigation here — flow
// orchestration and persistence live in `mcpOauthFlow.ts` / `mcpOauthStore.ts`.

import { fetchWithMcpProxyFallback } from './mcpProxy';

export type McpAuthServerMetadata = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
};

export type McpAuthDiscovery = McpAuthServerMetadata & {
  resource?: string;
};

export type McpOauthTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
};

export type PkcePair = {
  verifier: string;
  challenge: string;
};

function base64UrlEncode(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function createPkcePair(): Promise<PkcePair> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle || !cryptoApi.getRandomValues) {
    throw new Error('当前环境不支持 OAuth 授权所需的加密能力。');
  }
  const randomBytes = new Uint8Array(32);
  cryptoApi.getRandomValues(randomBytes);
  const verifier = base64UrlEncode(randomBytes);
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return {
    verifier,
    challenge: base64UrlEncode(new Uint8Array(digest))
  };
}

export function createOauthStateToken() {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new Error('当前环境不支持 OAuth 授权所需的加密能力。');
  }
  const randomBytes = new Uint8Array(16);
  cryptoApi.getRandomValues(randomBytes);
  return base64UrlEncode(randomBytes);
}

async function fetchJson(url: string, init: RequestInit, fetchImpl: typeof fetch) {
  const response = await fetchWithMcpProxyFallback(url, init, fetchImpl);
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}${bodyText ? ` · ${bodyText.trim().slice(0, 200)}` : ''}`);
  }
  return await response.json() as Record<string, unknown>;
}

async function tryFetchJson(url: string, fetchImpl: typeof fetch) {
  try {
    return await fetchJson(url, { method: 'GET', headers: { Accept: 'application/json' } }, fetchImpl);
  } catch {
    return null;
  }
}

function wellKnownCandidates(baseUrl: string, suffix: string) {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  const candidates = [`${url.origin}/.well-known/${suffix}${path}`];
  if (path) {
    candidates.push(`${url.origin}/.well-known/${suffix}`);
  }
  return candidates;
}

function parseAuthServerMetadata(payload: Record<string, unknown>): McpAuthServerMetadata | null {
  const issuer = typeof payload.issuer === 'string' ? payload.issuer : '';
  const authorizationEndpoint = typeof payload.authorization_endpoint === 'string' ? payload.authorization_endpoint : '';
  const tokenEndpoint = typeof payload.token_endpoint === 'string' ? payload.token_endpoint : '';
  if (!authorizationEndpoint || !tokenEndpoint) return null;

  return {
    issuer: issuer || authorizationEndpoint,
    authorizationEndpoint,
    tokenEndpoint,
    ...(typeof payload.registration_endpoint === 'string'
      ? { registrationEndpoint: payload.registration_endpoint }
      : {}),
    ...(Array.isArray(payload.scopes_supported)
      ? { scopesSupported: payload.scopes_supported.filter((entry): entry is string => typeof entry === 'string') }
      : {})
  };
}

async function discoverAuthServerMetadata(issuerUrl: string, fetchImpl: typeof fetch) {
  const candidates = [
    ...wellKnownCandidates(issuerUrl, 'oauth-authorization-server'),
    ...wellKnownCandidates(issuerUrl, 'openid-configuration')
  ];

  for (const candidate of candidates) {
    const payload = await tryFetchJson(candidate, fetchImpl);
    if (!payload) continue;
    const metadata = parseAuthServerMetadata(payload);
    if (metadata) return metadata;
  }
  return null;
}

// Discover how to authorize against an MCP server URL: protected-resource
// metadata first (it names the authorization server), then the issuer's
// authorization-server metadata; falls back to treating the MCP origin as
// the issuer when no protected-resource metadata is published.
export async function discoverMcpAuthorization(
  serverUrl: string,
  fetchImpl: typeof fetch
): Promise<McpAuthDiscovery> {
  let resource: string | undefined;
  let issuer = new URL(serverUrl).origin;

  for (const candidate of wellKnownCandidates(serverUrl, 'oauth-protected-resource')) {
    const payload = await tryFetchJson(candidate, fetchImpl);
    if (!payload) continue;
    if (typeof payload.resource === 'string' && payload.resource) {
      resource = payload.resource;
    }
    const servers = Array.isArray(payload.authorization_servers) ? payload.authorization_servers : [];
    const firstServer = servers.find((entry): entry is string => typeof entry === 'string' && Boolean(entry));
    if (firstServer) {
      issuer = firstServer;
    }
    break;
  }

  const metadata = await discoverAuthServerMetadata(issuer, fetchImpl);
  if (!metadata) {
    throw new Error('没有在服务器上发现 OAuth 授权配置（authorization server metadata）。');
  }

  return {
    ...metadata,
    ...(resource ? { resource } : {})
  };
}

export async function registerMcpOauthClient(args: {
  registrationEndpoint: string;
  redirectUri: string;
  clientName?: string;
  fetchImpl: typeof fetch;
}): Promise<string> {
  const payload = await fetchJson(args.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: args.clientName ?? 'Polaris',
      redirect_uris: [args.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    })
  }, args.fetchImpl);

  const clientId = typeof payload.client_id === 'string' ? payload.client_id : '';
  if (!clientId) {
    throw new Error('OAuth 客户端注册没有返回 client_id。');
  }
  return clientId;
}

export function buildMcpAuthorizeUrl(args: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  resource?: string;
  scope?: string;
}) {
  const url = new URL(args.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', args.clientId);
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('state', args.state);
  url.searchParams.set('code_challenge', args.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (args.resource) url.searchParams.set('resource', args.resource);
  if (args.scope) url.searchParams.set('scope', args.scope);
  return url.toString();
}

function parseTokenResponse(payload: Record<string, unknown>): McpOauthTokens {
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
  if (!accessToken) {
    throw new Error('OAuth 令牌响应缺少 access_token。');
  }
  const expiresIn = typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
    ? payload.expires_in
    : undefined;

  return {
    accessToken,
    ...(typeof payload.refresh_token === 'string' && payload.refresh_token
      ? { refreshToken: payload.refresh_token }
      : {}),
    ...(expiresIn !== undefined ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
    ...(typeof payload.scope === 'string' && payload.scope ? { scope: payload.scope } : {})
  };
}

async function postTokenRequest(
  tokenEndpoint: string,
  form: Record<string, string>,
  fetchImpl: typeof fetch
) {
  const body = new URLSearchParams(form).toString();
  const payload = await fetchJson(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body
  }, fetchImpl);
  return parseTokenResponse(payload);
}

export async function exchangeMcpAuthorizationCode(args: {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  resource?: string;
  fetchImpl: typeof fetch;
}): Promise<McpOauthTokens> {
  return await postTokenRequest(args.tokenEndpoint, {
    grant_type: 'authorization_code',
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    code_verifier: args.codeVerifier,
    ...(args.resource ? { resource: args.resource } : {})
  }, args.fetchImpl);
}

export async function refreshMcpOauthTokens(args: {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
  resource?: string;
  fetchImpl: typeof fetch;
}): Promise<McpOauthTokens> {
  const tokens = await postTokenRequest(args.tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    client_id: args.clientId,
    ...(args.resource ? { resource: args.resource } : {})
  }, args.fetchImpl);

  return {
    ...tokens,
    // Servers may omit the refresh token on refresh; keep the old one usable.
    refreshToken: tokens.refreshToken ?? args.refreshToken
  };
}
