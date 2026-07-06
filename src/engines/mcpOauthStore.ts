// Persistence for MCP OAuth state.
//
// Tokens and client registrations are runtime secrets scoped to this device,
// keyed by the normalized MCP server URL (not the server id) so a draft
// server that has not been saved yet can still complete an authorization,
// and re-adding the same URL reuses the grant. Pending flow records survive
// the full-page redirect to the authorization server and are matched back by
// the opaque `state` value. Backed by localStorage with an in-memory
// fallback for environments without it (tests, SSR).

import type { McpServerConfig } from '../types/domain';

const TOKENS_STORAGE_KEY = 'polaris.mcpOauth.tokens.v1';
const PENDING_STORAGE_KEY = 'polaris.mcpOauth.pending.v1';
const PENDING_FLOW_TTL_MS = 30 * 60 * 1000;

export type McpOauthGrant = {
  serverUrl: string;
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  resource?: string;
  scope?: string;
  redirectUri: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  updatedAt: number;
};

export type McpOauthPendingFlow = {
  state: string;
  codeVerifier: string;
  serverUrl: string;
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  resource?: string;
  scope?: string;
  redirectUri: string;
  serverId?: string;
  serverDraft?: Partial<McpServerConfig>;
  createdAt: number;
};

const memoryStore = new Map<string, string>();

function readRaw(key: string) {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(key);
    }
  } catch {
    // fall through to memory
  }
  return memoryStore.get(key) ?? null;
}

function writeRaw(key: string, value: string) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
      return;
    }
  } catch {
    // fall through to memory
  }
  memoryStore.set(key, value);
}

function readRecordMap<T>(key: string): Record<string, T> {
  const raw = readRaw(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, T>;
    }
  } catch {
    // corrupted payload — start over
  }
  return {};
}

function writeRecordMap<T>(key: string, value: Record<string, T>) {
  writeRaw(key, JSON.stringify(value));
}

export function normalizeMcpOauthServerUrl(serverUrl: string) {
  try {
    const url = new URL(serverUrl.trim());
    url.hash = '';
    url.search = '';
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${path}`;
  } catch {
    return serverUrl.trim().replace(/\/+$/, '');
  }
}

export function readMcpOauthGrant(serverUrl: string): McpOauthGrant | null {
  const grants = readRecordMap<McpOauthGrant>(TOKENS_STORAGE_KEY);
  return grants[normalizeMcpOauthServerUrl(serverUrl)] ?? null;
}

export function writeMcpOauthGrant(grant: McpOauthGrant) {
  const grants = readRecordMap<McpOauthGrant>(TOKENS_STORAGE_KEY);
  grants[normalizeMcpOauthServerUrl(grant.serverUrl)] = {
    ...grant,
    serverUrl: normalizeMcpOauthServerUrl(grant.serverUrl),
    updatedAt: Date.now()
  };
  writeRecordMap(TOKENS_STORAGE_KEY, grants);
}

export function clearMcpOauthGrant(serverUrl: string) {
  const grants = readRecordMap<McpOauthGrant>(TOKENS_STORAGE_KEY);
  delete grants[normalizeMcpOauthServerUrl(serverUrl)];
  writeRecordMap(TOKENS_STORAGE_KEY, grants);
}

export function writeMcpOauthPendingFlow(flow: McpOauthPendingFlow) {
  const flows = readRecordMap<McpOauthPendingFlow>(PENDING_STORAGE_KEY);
  const now = Date.now();
  for (const [state, entry] of Object.entries(flows)) {
    if (now - entry.createdAt > PENDING_FLOW_TTL_MS) {
      delete flows[state];
    }
  }
  flows[flow.state] = flow;
  writeRecordMap(PENDING_STORAGE_KEY, flows);
}

export function takeMcpOauthPendingFlow(state: string): McpOauthPendingFlow | null {
  const flows = readRecordMap<McpOauthPendingFlow>(PENDING_STORAGE_KEY);
  const flow = flows[state] ?? null;
  if (!flow) return null;
  delete flows[state];
  writeRecordMap(PENDING_STORAGE_KEY, flows);
  if (Date.now() - flow.createdAt > PENDING_FLOW_TTL_MS) {
    return null;
  }
  return flow;
}

export function clearMcpOauthStoreForTests() {
  memoryStore.clear();
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(TOKENS_STORAGE_KEY);
      localStorage.removeItem(PENDING_STORAGE_KEY);
    }
  } catch {
    // memory already cleared
  }
}
