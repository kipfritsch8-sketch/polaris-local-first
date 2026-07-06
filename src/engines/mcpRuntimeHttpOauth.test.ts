import { afterEach, describe, expect, it } from 'vitest';
import type { McpServerConfig } from '../types/domain';
import { clearMcpOauthStoreForTests, writeMcpOauthGrant } from './mcpOauthStore';
import { initializeStreamableSession } from './mcpRuntimeHttp';

const SERVER_URL = 'https://mcp.example.com/mcp';

function buildServer(): McpServerConfig {
  return {
    id: 'server-1',
    handle: 'ombre',
    name: 'Ombre brain',
    description: '',
    transport: 'streamable-http',
    url: SERVER_URL,
    headers: [],
    authMode: 'oauth',
    tools: [],
    isActive: true
  };
}

function seedGrant(accessToken: string) {
  writeMcpOauthGrant({
    serverUrl: SERVER_URL,
    clientId: 'client-1',
    authorizationEndpoint: 'https://mcp.example.com/oauth/authorize',
    tokenEndpoint: 'https://mcp.example.com/oauth/token',
    redirectUri: 'https://app.example.com/',
    accessToken,
    refreshToken: 'refresh-1',
    updatedAt: Date.now()
  });
}

afterEach(() => {
  clearMcpOauthStoreForTests();
});

describe('streamable HTTP with OAuth', () => {
  it('sends the bearer token and retries once after a 401 by refreshing', async () => {
    seedGrant('access-stale');
    const seenAuthHeaders: string[] = [];

    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === 'https://mcp.example.com/oauth/token') {
        return new Response(JSON.stringify({ access_token: 'access-renewed', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const auth = new Headers(init?.headers ?? undefined).get('Authorization') ?? '';
      const payload = JSON.parse(String(init?.body ?? '{}')) as { id?: string | number; method?: string };
      if (payload.method === 'initialize') {
        seenAuthHeaders.push(auth);
        if (auth !== 'Bearer access-renewed') {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
        }
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-1' }
        });
      }
      // notifications/initialized
      return new Response(null, { status: 202 });
    }) as typeof fetch;

    const session = await initializeStreamableSession({
      server: buildServer(),
      timeoutMs: 5000,
      fetchImpl: fetchStub
    });

    expect(session.sessionId).toBe('session-1');
    expect(seenAuthHeaders).toEqual(['Bearer access-stale', 'Bearer access-renewed']);
  });
});
