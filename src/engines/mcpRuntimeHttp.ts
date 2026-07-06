// Streamable HTTP transport for the MCP runtime.
//
// Owns the streamable-http session lifecycle (initialize → notifications/initialized
// → requests → DELETE), the single-shot HTTP request including the native
// CapacitorHttp bridge, and parsing one HTTP response (JSON or text/event-stream)
// into a JSON-RPC message. No catalog, no cache, no persistent SSE connection —
// that legacy transport lives separately.

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import {
  forceRefreshMcpAuthorization,
  resolveMcpAuthorizationHeader
} from './mcpOauthFlow';
import { fetchWithMcpProxyFallback } from './mcpProxy';
import {
  createRpcId,
  ensureSuccessMessage,
  findResponseMessage
} from './mcpRuntimeJsonRpc';
import type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest
} from './mcpRuntimeJsonRpc';
import { createTimeoutError } from './mcpRuntimeTiming';
import {
  buildServerHeaders,
  getFetchImpl,
  MCP_CLIENT_INFO,
  MCP_PROTOCOL_VERSION,
  parseSseEvents
} from './mcpRuntimeTransport';
import type { InitializeResult, McpTransportOptions } from './mcpRuntimeTransport';

export type StreamableSession = {
  endpoint: string;
  protocolVersion: string;
  sessionId?: string;
};

function shouldUseNativeMcpHttp(url: string, options: McpTransportOptions) {
  if (options.fetchImpl) {
    return false;
  }
  if (options.server.transport !== 'streamable-http') {
    return false;
  }
  if (!Capacitor.isNativePlatform()) {
    return false;
  }
  const platform = Capacitor.getPlatform();
  if (platform !== 'ios' && platform !== 'android') {
    return false;
  }

  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function serializeNativeHttpBody(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function createResponseFromNativeHttp(result: Awaited<ReturnType<typeof CapacitorHttp.request>>) {
  return new Response(serializeNativeHttpBody(result.data), {
    status: result.status,
    headers: result.headers
  });
}

async function requestMcpHttp(
  url: string,
  init: RequestInit,
  options: McpTransportOptions
) {
  if (!shouldUseNativeMcpHttp(url, options)) {
    const fetchImpl = getFetchImpl(options.fetchImpl);
    return await fetchWithMcpProxyFallback(url, init, fetchImpl);
  }

  const headers = new Headers(init.headers ?? undefined);
  const body = init.body;
  const nativeResponse = await CapacitorHttp.request({
    url,
    method: init.method ?? 'GET',
    headers: Object.fromEntries(headers.entries()),
    data: typeof body === 'string' ? body : body ? String(body) : undefined,
    responseType: 'text',
    connectTimeout: options.timeoutMs,
    readTimeout: options.timeoutMs
  });

  return createResponseFromNativeHttp(nativeResponse);
}

function dispatchJsonRpcFromSseData(
  rawData: string,
  expectedId: JsonRpcId
): JsonRpcMessage | null {
  try {
    const parsed = JSON.parse(rawData) as unknown;
    return findResponseMessage(parsed, expectedId);
  } catch {
    return null;
  }
}

async function readSseResponseForId(response: Response, expectedId: JsonRpcId, label: string) {
  const bodyText = await response.text();
  const events = parseSseEvents(bodyText);

  for (const event of events) {
    if (event.event !== 'message') continue;
    const match = dispatchJsonRpcFromSseData(event.data, expectedId);
    if (match) return match;
  }

  throw new Error(`${label} 没有在 SSE 响应里拿到结果。`);
}

async function parseHttpJsonRpcResponse(
  response: Response,
  expectedId: JsonRpcId,
  label: string
) {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`${label} 失败：HTTP ${response.status}${errorText ? ` · ${errorText.trim()}` : ''}`);
  }

  if (response.status === 202) {
    return null;
  }

  if (contentType.includes('text/event-stream')) {
    return await readSseResponseForId(response, expectedId, label);
  }

  const parsed = await response.json().catch(() => null);
  const matched = findResponseMessage(parsed, expectedId);
  if (!matched) {
    throw new Error(`${label} 返回了无法识别的 JSON-RPC 结果。`);
  }
  return matched;
}

async function postStreamableJsonRpc(
  payload: JsonRpcRequest | JsonRpcNotification,
  options: McpTransportOptions & Partial<StreamableSession> & { label: string }
) {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(createTimeoutError(options.label, options.timeoutMs)), options.timeoutMs);

  const sendOnce = async () => {
    const headers = buildServerHeaders(options.server, {
      'Content-Type': 'application/json',
      ...(await resolveMcpAuthorizationHeader(options.server, options.fetchImpl)),
      ...(options.protocolVersion ? { 'MCP-Protocol-Version': options.protocolVersion } : {}),
      ...(options.sessionId ? { 'Mcp-Session-Id': options.sessionId } : {})
    });

    return await requestMcpHttp(options.endpoint ?? options.server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    }, options);
  };

  try {
    const response = await sendOnce();
    if (response.status !== 401 || options.server.authMode !== 'oauth') {
      return response;
    }
    // One forced token refresh, then one retry — an expired access token is
    // the common 401 for OAuth servers. Anything else surfaces as-is.
    const refreshed = await forceRefreshMcpAuthorization(options.server, options.fetchImpl);
    if (!refreshed) {
      return response;
    }
    return await sendOnce();
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

export async function initializeStreamableSession(options: McpTransportOptions): Promise<StreamableSession> {
  const requestId = createRpcId();
  const response = await postStreamableJsonRpc({
    jsonrpc: '2.0',
    id: requestId,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: MCP_CLIENT_INFO
    }
  }, {
    ...options,
    endpoint: options.server.url,
    label: `初始化 MCP 服务 ${options.server.name}`
  });
  const sessionId = response.headers.get('Mcp-Session-Id') ?? undefined;
  const message = ensureSuccessMessage(
    await parseHttpJsonRpcResponse(response, requestId, `初始化 MCP 服务 ${options.server.name}`),
    `初始化 MCP 服务 ${options.server.name}`
  );
  const result = (message.result ?? {}) as InitializeResult;
  const protocolVersion = typeof result.protocolVersion === 'string' && result.protocolVersion.trim()
    ? result.protocolVersion
    : MCP_PROTOCOL_VERSION;

  await postStreamableJsonRpc({
    jsonrpc: '2.0',
    method: 'notifications/initialized'
  }, {
    ...options,
    endpoint: options.server.url,
    protocolVersion,
    sessionId,
    label: `确认 MCP 服务 ${options.server.name} 初始化`
  }).catch(() => null);

  return {
    endpoint: options.server.url,
    protocolVersion,
    sessionId
  };
}

export async function closeStreamableSession(options: McpTransportOptions & StreamableSession) {
  if (!options.sessionId) return;
  try {
    await requestMcpHttp(options.endpoint, {
      method: 'DELETE',
      headers: buildServerHeaders(options.server, {
        ...(await resolveMcpAuthorizationHeader(options.server, options.fetchImpl).catch(() => ({}))),
        'MCP-Protocol-Version': options.protocolVersion,
        'Mcp-Session-Id': options.sessionId
      })
    }, options);
  } catch {
    // ignore close failures
  }
}

export async function requestStreamableJsonRpc(
  payload: JsonRpcRequest,
  options: McpTransportOptions & StreamableSession & { label: string }
) {
  const response = await postStreamableJsonRpc(payload, options);
  return ensureSuccessMessage(
    await parseHttpJsonRpcResponse(response, payload.id, options.label),
    options.label
  );
}
