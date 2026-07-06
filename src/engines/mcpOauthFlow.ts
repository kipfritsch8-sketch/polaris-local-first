// MCP OAuth flow orchestration.
//
// Ties the protocol primitives (`mcpOauth.ts`) to persisted grants
// (`mcpOauthStore.ts`): start an authorization (discover → register →
// authorize URL), complete the redirect callback (code → tokens), hand the
// current Authorization header to the transports, and refresh once when a
// request comes back 401. The transports stay unaware of OAuth mechanics —
// they only call `resolveMcpAuthorizationHeader` and
// `forceRefreshMcpAuthorization`.

import type { McpServerConfig } from '../types/domain';
import {
  buildMcpAuthorizeUrl,
  createOauthStateToken,
  createPkcePair,
  discoverMcpAuthorization,
  exchangeMcpAuthorizationCode,
  refreshMcpOauthTokens,
  registerMcpOauthClient
} from './mcpOauth';
import {
  clearMcpOauthGrant,
  normalizeMcpOauthServerUrl,
  readMcpOauthGrant,
  takeMcpOauthPendingFlow,
  writeMcpOauthGrant,
  writeMcpOauthPendingFlow
} from './mcpOauthStore';
import type { McpOauthGrant } from './mcpOauthStore';

const TOKEN_EXPIRY_LEEWAY_MS = 30 * 1000;

export type McpOauthAuthorizationStatus = 'none' | 'authorized' | 'expired';

export type McpOauthCallbackResult = {
  serverUrl: string;
  serverId?: string;
  serverDraft?: Partial<McpServerConfig>;
};

function getDefaultRedirectUri() {
  if (typeof window === 'undefined') {
    throw new Error('当前环境无法发起 OAuth 授权跳转。');
  }
  return `${window.location.origin}/`;
}

function resolveFetchImpl(fetchImpl?: typeof fetch) {
  const resolved = fetchImpl ?? globalThis.fetch;
  if (!resolved) {
    throw new Error('当前环境没有 fetch，无法进行 OAuth 授权。');
  }
  return resolved;
}

// Begin the authorization redirect for a server (saved or still a draft).
// Returns the URL to navigate to; the pending flow state survives the
// round-trip in local storage.
export async function startMcpOauthAuthorization(args: {
  server: Pick<McpServerConfig, 'url' | 'name'> & Partial<McpServerConfig>;
  redirectUri?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ authorizeUrl: string }> {
  const fetchImpl = resolveFetchImpl(args.fetchImpl);
  const serverUrl = normalizeMcpOauthServerUrl(args.server.url);
  if (!serverUrl) {
    throw new Error('先填写服务器地址再发起授权。');
  }
  const redirectUri = args.redirectUri ?? getDefaultRedirectUri();

  const discovery = await discoverMcpAuthorization(serverUrl, fetchImpl);

  const existingGrant = readMcpOauthGrant(serverUrl);
  const reusableClientId = existingGrant && existingGrant.redirectUri === redirectUri
    ? existingGrant.clientId
    : null;

  let clientId = reusableClientId ?? '';
  if (!clientId) {
    if (!discovery.registrationEndpoint) {
      throw new Error('服务器不支持动态注册（registration endpoint 缺失），无法自动完成 OAuth。');
    }
    clientId = await registerMcpOauthClient({
      registrationEndpoint: discovery.registrationEndpoint,
      redirectUri,
      fetchImpl
    });
  }

  const pkce = await createPkcePair();
  const state = createOauthStateToken();
  const scope = discovery.scopesSupported?.length ? discovery.scopesSupported.join(' ') : undefined;

  writeMcpOauthPendingFlow({
    state,
    codeVerifier: pkce.verifier,
    serverUrl,
    clientId,
    authorizationEndpoint: discovery.authorizationEndpoint,
    tokenEndpoint: discovery.tokenEndpoint,
    ...(discovery.registrationEndpoint ? { registrationEndpoint: discovery.registrationEndpoint } : {}),
    ...(discovery.resource ? { resource: discovery.resource } : {}),
    ...(scope ? { scope } : {}),
    redirectUri,
    ...(args.server.id ? { serverId: args.server.id } : {}),
    serverDraft: {
      name: args.server.name,
      description: args.server.description,
      transport: args.server.transport,
      url: args.server.url,
      headers: args.server.headers,
      authMode: 'oauth',
      tools: args.server.tools,
      isActive: args.server.isActive ?? true
    },
    createdAt: Date.now()
  });

  return {
    authorizeUrl: buildMcpAuthorizeUrl({
      authorizationEndpoint: discovery.authorizationEndpoint,
      clientId,
      redirectUri,
      state,
      codeChallenge: pkce.challenge,
      ...(discovery.resource ? { resource: discovery.resource } : {}),
      ...(scope ? { scope } : {})
    })
  };
}

// Recognize an OAuth redirect landing: `?code=…&state=…` (or `?error=…`)
// where the state matches a pending flow we started.
export function detectMcpOauthCallback(href: string) {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const state = url.searchParams.get('state');
  if (!state) return null;
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (!code && !error) return null;
  return {
    state,
    code,
    error,
    errorDescription: url.searchParams.get('error_description')
  };
}

export async function completeMcpOauthCallback(args: {
  state: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<McpOauthCallbackResult | null> {
  const pending = takeMcpOauthPendingFlow(args.state);
  if (!pending) return null;
  const fetchImpl = resolveFetchImpl(args.fetchImpl);

  const tokens = await exchangeMcpAuthorizationCode({
    tokenEndpoint: pending.tokenEndpoint,
    clientId: pending.clientId,
    code: args.code,
    codeVerifier: pending.codeVerifier,
    redirectUri: pending.redirectUri,
    ...(pending.resource ? { resource: pending.resource } : {}),
    fetchImpl
  });

  writeMcpOauthGrant({
    serverUrl: pending.serverUrl,
    clientId: pending.clientId,
    authorizationEndpoint: pending.authorizationEndpoint,
    tokenEndpoint: pending.tokenEndpoint,
    ...(pending.registrationEndpoint ? { registrationEndpoint: pending.registrationEndpoint } : {}),
    ...(pending.resource ? { resource: pending.resource } : {}),
    ...(tokens.scope ? { scope: tokens.scope } : pending.scope ? { scope: pending.scope } : {}),
    redirectUri: pending.redirectUri,
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
    updatedAt: Date.now()
  });

  return {
    serverUrl: pending.serverUrl,
    ...(pending.serverId ? { serverId: pending.serverId } : {}),
    ...(pending.serverDraft ? { serverDraft: pending.serverDraft } : {})
  };
}

export function getMcpAuthorizationStatus(serverUrl: string): McpOauthAuthorizationStatus {
  const grant = readMcpOauthGrant(serverUrl);
  if (!grant) return 'none';
  const expired = grant.expiresAt !== undefined && grant.expiresAt <= Date.now();
  if (expired && !grant.refreshToken) return 'expired';
  return 'authorized';
}

export function clearMcpAuthorization(serverUrl: string) {
  clearMcpOauthGrant(serverUrl);
}

const refreshInFlight = new Map<string, Promise<McpOauthGrant | null>>();

async function refreshGrant(grant: McpOauthGrant, fetchImpl: typeof fetch): Promise<McpOauthGrant | null> {
  if (!grant.refreshToken) return null;
  const key = grant.serverUrl;
  const inFlight = refreshInFlight.get(key);
  if (inFlight) return await inFlight;

  const task = (async () => {
    try {
      const tokens = await refreshMcpOauthTokens({
        tokenEndpoint: grant.tokenEndpoint,
        clientId: grant.clientId,
        refreshToken: grant.refreshToken!,
        ...(grant.resource ? { resource: grant.resource } : {}),
        fetchImpl
      });
      const nextGrant: McpOauthGrant = {
        ...grant,
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : { expiresAt: undefined }),
        updatedAt: Date.now()
      };
      writeMcpOauthGrant(nextGrant);
      return nextGrant;
    } catch {
      return null;
    } finally {
      refreshInFlight.delete(key);
    }
  })();

  refreshInFlight.set(key, task);
  return await task;
}

// The transports call this before each request for `authMode: 'oauth'`
// servers. Refreshes proactively when the stored token is at/near expiry.
export async function resolveMcpAuthorizationHeader(
  server: Pick<McpServerConfig, 'url' | 'authMode'>,
  fetchImpl?: typeof fetch
): Promise<Record<string, string>> {
  if (server.authMode !== 'oauth') return {};
  const grant = readMcpOauthGrant(server.url);
  if (!grant) {
    throw new Error('这个 MCP 服务还没有完成 OAuth 授权，请在编辑页里点「去授权」。');
  }

  const nearExpiry = grant.expiresAt !== undefined && grant.expiresAt - Date.now() <= TOKEN_EXPIRY_LEEWAY_MS;
  if (nearExpiry) {
    const refreshed = await refreshGrant(grant, resolveFetchImpl(fetchImpl));
    if (refreshed) {
      return { Authorization: `Bearer ${refreshed.accessToken}` };
    }
    if (grant.expiresAt !== undefined && grant.expiresAt <= Date.now()) {
      throw new Error('OAuth 令牌已过期且无法自动续期，请重新授权。');
    }
  }

  return { Authorization: `Bearer ${grant.accessToken}` };
}

// One forced refresh after a 401; returns whether a retry is worthwhile.
export async function forceRefreshMcpAuthorization(
  server: Pick<McpServerConfig, 'url' | 'authMode'>,
  fetchImpl?: typeof fetch
): Promise<boolean> {
  if (server.authMode !== 'oauth') return false;
  const grant = readMcpOauthGrant(server.url);
  if (!grant) return false;
  const refreshed = await refreshGrant(grant, resolveFetchImpl(fetchImpl));
  return refreshed !== null;
}
