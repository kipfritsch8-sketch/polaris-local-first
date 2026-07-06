import { afterEach, describe, expect, it } from 'vitest';
import {
  completeMcpOauthCallback,
  detectMcpOauthCallback,
  forceRefreshMcpAuthorization,
  getMcpAuthorizationStatus,
  resolveMcpAuthorizationHeader,
  startMcpOauthAuthorization
} from './mcpOauthFlow';
import {
  clearMcpOauthStoreForTests,
  readMcpOauthGrant,
  writeMcpOauthGrant
} from './mcpOauthStore';

const SERVER_URL = 'https://mcp.example.com/mcp';
const REDIRECT_URI = 'https://app.example.com/';

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function createServerFetchStub(overrides?: {
  tokenPayload?: Record<string, unknown>;
}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });

    if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') {
      return jsonResponse({
        resource: SERVER_URL,
        authorization_servers: ['https://mcp.example.com']
      });
    }
    if (url === 'https://mcp.example.com/.well-known/oauth-authorization-server') {
      return jsonResponse({
        issuer: 'https://mcp.example.com',
        authorization_endpoint: 'https://mcp.example.com/oauth/authorize',
        token_endpoint: 'https://mcp.example.com/oauth/token',
        registration_endpoint: 'https://mcp.example.com/oauth/register',
        scopes_supported: ['mcp']
      });
    }
    if (url === 'https://mcp.example.com/oauth/register') {
      return jsonResponse({ client_id: 'client-registered' });
    }
    if (url === 'https://mcp.example.com/oauth/token') {
      return jsonResponse(overrides?.tokenPayload ?? {
        access_token: 'access-fresh',
        refresh_token: 'refresh-fresh',
        expires_in: 3600
      });
    }
    return jsonResponse({ error: 'not found' }, 404);
  }) as typeof fetch;
  return { fetchStub, calls };
}

afterEach(() => {
  clearMcpOauthStoreForTests();
});

describe('startMcpOauthAuthorization + completeMcpOauthCallback', () => {
  it('runs the full discover → register → authorize → exchange loop', async () => {
    const { fetchStub } = createServerFetchStub();

    const { authorizeUrl } = await startMcpOauthAuthorization({
      server: { name: 'Ombre brain', url: SERVER_URL, transport: 'streamable-http' },
      redirectUri: REDIRECT_URI,
      fetchImpl: fetchStub
    });

    const parsed = new URL(authorizeUrl);
    expect(parsed.origin + parsed.pathname).toBe('https://mcp.example.com/oauth/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('client-registered');
    expect(parsed.searchParams.get('scope')).toBe('mcp');
    const state = parsed.searchParams.get('state')!;
    expect(state).toBeTruthy();

    const result = await completeMcpOauthCallback({
      state,
      code: 'auth-code-1',
      fetchImpl: fetchStub
    });

    expect(result?.serverUrl).toBe(SERVER_URL);
    expect(result?.serverDraft?.name).toBe('Ombre brain');
    expect(result?.serverDraft?.authMode).toBe('oauth');

    const grant = readMcpOauthGrant(SERVER_URL);
    expect(grant?.accessToken).toBe('access-fresh');
    expect(grant?.refreshToken).toBe('refresh-fresh');
    expect(getMcpAuthorizationStatus(SERVER_URL)).toBe('authorized');
  });

  it('ignores callbacks for states it never started', async () => {
    const result = await completeMcpOauthCallback({
      state: 'unknown-state',
      code: 'code'
    });
    expect(result).toBeNull();
  });

  it('consumes the pending flow so a state cannot be replayed', async () => {
    const { fetchStub } = createServerFetchStub();
    const { authorizeUrl } = await startMcpOauthAuthorization({
      server: { name: 'Ombre brain', url: SERVER_URL, transport: 'streamable-http' },
      redirectUri: REDIRECT_URI,
      fetchImpl: fetchStub
    });
    const state = new URL(authorizeUrl).searchParams.get('state')!;

    expect(await completeMcpOauthCallback({ state, code: 'code-1', fetchImpl: fetchStub })).not.toBeNull();
    expect(await completeMcpOauthCallback({ state, code: 'code-1', fetchImpl: fetchStub })).toBeNull();
  });
});

describe('detectMcpOauthCallback', () => {
  it('recognizes code and error callbacks and ignores plain boots', () => {
    expect(detectMcpOauthCallback('https://app.example.com/?code=c&state=s')).toMatchObject({
      code: 'c',
      state: 's'
    });
    expect(detectMcpOauthCallback('https://app.example.com/?error=access_denied&state=s')).toMatchObject({
      error: 'access_denied'
    });
    expect(detectMcpOauthCallback('https://app.example.com/')).toBeNull();
    expect(detectMcpOauthCallback('https://app.example.com/?state=s')).toBeNull();
  });
});

describe('resolveMcpAuthorizationHeader', () => {
  it('returns nothing for headers-mode servers', async () => {
    await expect(resolveMcpAuthorizationHeader({ url: SERVER_URL, authMode: 'headers' })).resolves.toEqual({});
  });

  it('returns the bearer token for an authorized server', async () => {
    writeMcpOauthGrant({
      serverUrl: SERVER_URL,
      clientId: 'client-1',
      authorizationEndpoint: 'https://mcp.example.com/oauth/authorize',
      tokenEndpoint: 'https://mcp.example.com/oauth/token',
      redirectUri: REDIRECT_URI,
      accessToken: 'access-live',
      expiresAt: Date.now() + 60 * 60 * 1000,
      updatedAt: Date.now()
    });

    await expect(resolveMcpAuthorizationHeader({ url: SERVER_URL, authMode: 'oauth' }))
      .resolves.toEqual({ Authorization: 'Bearer access-live' });
  });

  it('refreshes an expired token before use', async () => {
    const { fetchStub } = createServerFetchStub({
      tokenPayload: { access_token: 'access-renewed', expires_in: 3600 }
    });
    writeMcpOauthGrant({
      serverUrl: SERVER_URL,
      clientId: 'client-1',
      authorizationEndpoint: 'https://mcp.example.com/oauth/authorize',
      tokenEndpoint: 'https://mcp.example.com/oauth/token',
      redirectUri: REDIRECT_URI,
      accessToken: 'access-stale',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() - 1000,
      updatedAt: Date.now()
    });

    await expect(resolveMcpAuthorizationHeader({ url: SERVER_URL, authMode: 'oauth' }, fetchStub))
      .resolves.toEqual({ Authorization: 'Bearer access-renewed' });
    expect(readMcpOauthGrant(SERVER_URL)?.refreshToken).toBe('refresh-1');
  });

  it('rejects when the server was never authorized', async () => {
    await expect(resolveMcpAuthorizationHeader({ url: SERVER_URL, authMode: 'oauth' }))
      .rejects.toThrow(/授权/);
  });
});

describe('forceRefreshMcpAuthorization', () => {
  it('refreshes once and reports success for retry decisions', async () => {
    const { fetchStub } = createServerFetchStub({
      tokenPayload: { access_token: 'access-after-401', expires_in: 3600 }
    });
    writeMcpOauthGrant({
      serverUrl: SERVER_URL,
      clientId: 'client-1',
      authorizationEndpoint: 'https://mcp.example.com/oauth/authorize',
      tokenEndpoint: 'https://mcp.example.com/oauth/token',
      redirectUri: REDIRECT_URI,
      accessToken: 'access-revoked',
      refreshToken: 'refresh-1',
      updatedAt: Date.now()
    });

    await expect(forceRefreshMcpAuthorization({ url: SERVER_URL, authMode: 'oauth' }, fetchStub))
      .resolves.toBe(true);
    expect(readMcpOauthGrant(SERVER_URL)?.accessToken).toBe('access-after-401');
  });

  it('reports failure without a refresh token', async () => {
    writeMcpOauthGrant({
      serverUrl: SERVER_URL,
      clientId: 'client-1',
      authorizationEndpoint: 'https://mcp.example.com/oauth/authorize',
      tokenEndpoint: 'https://mcp.example.com/oauth/token',
      redirectUri: REDIRECT_URI,
      accessToken: 'access-revoked',
      updatedAt: Date.now()
    });

    await expect(forceRefreshMcpAuthorization({ url: SERVER_URL, authMode: 'oauth' }))
      .resolves.toBe(false);
  });
});
