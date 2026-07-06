import { describe, expect, it } from 'vitest';
import {
  buildMcpAuthorizeUrl,
  createPkcePair,
  discoverMcpAuthorization,
  exchangeMcpAuthorizationCode,
  refreshMcpOauthTokens
} from './mcpOauth';

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function createFetchStub(routes: Record<string, (init?: RequestInit) => Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const handler = routes[url];
    if (!handler) return jsonResponse({ error: 'not found' }, 404);
    return handler(init);
  }) as typeof fetch;
  return { fetchStub, calls };
}

describe('createPkcePair', () => {
  it('creates a base64url verifier and S256 challenge', async () => {
    const pair = await createPkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).not.toBe(pair.verifier);

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pair.verifier));
    const expected = Buffer.from(new Uint8Array(digest))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(pair.challenge).toBe(expected);
  });
});

describe('buildMcpAuthorizeUrl', () => {
  it('carries the PKCE, state, resource, and scope parameters', () => {
    const url = new URL(buildMcpAuthorizeUrl({
      authorizationEndpoint: 'https://mcp.example.com/oauth/authorize',
      clientId: 'client-1',
      redirectUri: 'https://app.example.com/',
      state: 'state-1',
      codeChallenge: 'challenge-1',
      resource: 'https://mcp.example.com/mcp',
      scope: 'mcp'
    }));

    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe('https://mcp.example.com/mcp');
    expect(url.searchParams.get('scope')).toBe('mcp');
  });
});

describe('discoverMcpAuthorization', () => {
  it('resolves protected-resource metadata and the authorization server it names', async () => {
    const { fetchStub } = createFetchStub({
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp': () => jsonResponse({
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://auth.example.com']
      }),
      'https://auth.example.com/.well-known/oauth-authorization-server': () => jsonResponse({
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/oauth/authorize',
        token_endpoint: 'https://auth.example.com/oauth/token',
        registration_endpoint: 'https://auth.example.com/oauth/register',
        scopes_supported: ['mcp']
      })
    });

    const discovery = await discoverMcpAuthorization('https://mcp.example.com/mcp', fetchStub);
    expect(discovery.resource).toBe('https://mcp.example.com/mcp');
    expect(discovery.authorizationEndpoint).toBe('https://auth.example.com/oauth/authorize');
    expect(discovery.tokenEndpoint).toBe('https://auth.example.com/oauth/token');
    expect(discovery.registrationEndpoint).toBe('https://auth.example.com/oauth/register');
    expect(discovery.scopesSupported).toEqual(['mcp']);
  });

  it('falls back to the MCP origin as issuer without protected-resource metadata', async () => {
    const { fetchStub } = createFetchStub({
      'https://mcp.example.com/.well-known/oauth-authorization-server': () => jsonResponse({
        issuer: 'https://mcp.example.com',
        authorization_endpoint: 'https://mcp.example.com/oauth/authorize',
        token_endpoint: 'https://mcp.example.com/oauth/token'
      })
    });

    const discovery = await discoverMcpAuthorization('https://mcp.example.com/mcp', fetchStub);
    expect(discovery.resource).toBeUndefined();
    expect(discovery.authorizationEndpoint).toBe('https://mcp.example.com/oauth/authorize');
  });

  it('throws when no authorization metadata exists anywhere', async () => {
    const { fetchStub } = createFetchStub({});
    await expect(discoverMcpAuthorization('https://mcp.example.com/mcp', fetchStub))
      .rejects.toThrow(/authorization server metadata/);
  });
});

describe('token exchanges', () => {
  it('exchanges an authorization code with PKCE and resource', async () => {
    const { fetchStub, calls } = createFetchStub({
      'https://auth.example.com/oauth/token': () => jsonResponse({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        scope: 'mcp'
      })
    });

    const tokens = await exchangeMcpAuthorizationCode({
      tokenEndpoint: 'https://auth.example.com/oauth/token',
      clientId: 'client-1',
      code: 'code-1',
      codeVerifier: 'verifier-1',
      redirectUri: 'https://app.example.com/',
      resource: 'https://mcp.example.com/mcp',
      fetchImpl: fetchStub
    });

    expect(tokens.accessToken).toBe('access-1');
    expect(tokens.refreshToken).toBe('refresh-1');
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    expect(tokens.scope).toBe('mcp');

    const form = new URLSearchParams(String(calls[0]?.init?.body ?? ''));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('code-1');
    expect(form.get('code_verifier')).toBe('verifier-1');
    expect(form.get('client_id')).toBe('client-1');
    expect(form.get('resource')).toBe('https://mcp.example.com/mcp');
  });

  it('keeps the previous refresh token when the server omits it on refresh', async () => {
    const { fetchStub } = createFetchStub({
      'https://auth.example.com/oauth/token': () => jsonResponse({
        access_token: 'access-2',
        expires_in: 600
      })
    });

    const tokens = await refreshMcpOauthTokens({
      tokenEndpoint: 'https://auth.example.com/oauth/token',
      clientId: 'client-1',
      refreshToken: 'refresh-1',
      fetchImpl: fetchStub
    });

    expect(tokens.accessToken).toBe('access-2');
    expect(tokens.refreshToken).toBe('refresh-1');
  });

  it('surfaces token endpoint failures', async () => {
    const { fetchStub } = createFetchStub({
      'https://auth.example.com/oauth/token': () => jsonResponse({ error: 'invalid_grant' }, 400)
    });

    await expect(refreshMcpOauthTokens({
      tokenEndpoint: 'https://auth.example.com/oauth/token',
      clientId: 'client-1',
      refreshToken: 'refresh-x',
      fetchImpl: fetchStub
    })).rejects.toThrow(/HTTP 400/);
  });
});
