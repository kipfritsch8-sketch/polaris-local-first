// Same-origin MCP proxy fallback.
//
// Browser pages are subject to CORS, and many MCP servers (and their OAuth
// metadata endpoints) do not allow cross-origin requests from arbitrary web
// origins. Web deployments ship a same-origin relay at `/api/mcp-proxy`
// (see `functions/api/mcp-proxy.ts`) that forwards the request server-side.
// This module decides when to use it: direct fetch first, proxy retry on a
// network-level failure, and the working choice is remembered per target
// origin for the rest of the session.

import { Capacitor } from '@capacitor/core';

export const MCP_PROXY_PATH = '/api/mcp-proxy';
export const MCP_PROXY_MARKER_HEADER = 'X-Polaris-Mcp-Proxy';

const proxyPreferenceByOrigin = new Map<string, 'direct' | 'proxy'>();

export function isMcpProxyAvailable() {
  if (typeof window === 'undefined') return false;
  if (Capacitor.isNativePlatform()) return false;
  const protocol = window.location?.protocol;
  return protocol === 'https:' || protocol === 'http:';
}

export function buildMcpProxyUrl(targetUrl: string) {
  return `${MCP_PROXY_PATH}?target=${encodeURIComponent(targetUrl)}`;
}

function targetOriginOf(targetUrl: string) {
  try {
    return new URL(targetUrl).origin;
  } catch {
    return targetUrl;
  }
}

function isSameOriginTarget(targetUrl: string) {
  if (typeof window === 'undefined') return false;
  try {
    return new URL(targetUrl, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

export function clearMcpProxyPreferenceForTests() {
  proxyPreferenceByOrigin.clear();
}

// The marker header is only added on the same-origin proxy request (it would
// force a CORS preflight if sent on the direct cross-origin request).
function buildProxyInit(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers ?? undefined);
  headers.set(MCP_PROXY_MARKER_HEADER, '1');
  return { ...init, headers };
}

// Fetch `targetUrl` directly, falling back to the same-origin proxy when the
// direct request dies at the network layer (CORS rejections surface as
// TypeError without a Response). HTTP error statuses are returned as-is —
// they mean the server was reachable and the proxy would not change anything.
export async function fetchWithMcpProxyFallback(
  targetUrl: string,
  init: RequestInit,
  fetchImpl: typeof fetch
): Promise<Response> {
  if (!isMcpProxyAvailable() || isSameOriginTarget(targetUrl)) {
    return await fetchImpl(targetUrl, init);
  }

  const origin = targetOriginOf(targetUrl);
  if (proxyPreferenceByOrigin.get(origin) === 'proxy') {
    return await fetchImpl(buildMcpProxyUrl(targetUrl), buildProxyInit(init));
  }

  try {
    const response = await fetchImpl(targetUrl, init);
    proxyPreferenceByOrigin.set(origin, 'direct');
    return response;
  } catch (error) {
    if (init.signal?.aborted) throw error;
    if (!(error instanceof TypeError)) throw error;

    const proxied = await fetchImpl(buildMcpProxyUrl(targetUrl), buildProxyInit(init)).catch(() => null);
    if (!proxied || proxied.status === 404 || proxied.status === 501) {
      // No proxy deployed on this origin — surface the original failure.
      throw error;
    }
    proxyPreferenceByOrigin.set(origin, 'proxy');
    return proxied;
  }
}
