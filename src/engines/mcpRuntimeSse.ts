// Legacy SSE transport for the MCP runtime.
//
// The older two-channel transport: a long-lived GET stream delivers an `endpoint`
// event and then server→client JSON-RPC messages, while requests are POSTed to that
// endpoint and correlated back by id. Owns the persistent connection and its pending
// map; no catalog, no cache. The streamable HTTP transport lives separately.

import { resolveMcpAuthorizationHeader } from './mcpOauthFlow';
import { fetchWithMcpProxyFallback } from './mcpProxy';
import {
  createRpcId,
  ensureSuccessMessage,
  findResponseMessage,
  parseJsonRpcMessage
} from './mcpRuntimeJsonRpc';
import type {
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest
} from './mcpRuntimeJsonRpc';
import { createTimeoutError, withTimeout } from './mcpRuntimeTiming';
import {
  buildServerHeaders,
  getFetchImpl,
  MCP_CLIENT_INFO,
  MCP_PROTOCOL_VERSION,
  parseSseEvents
} from './mcpRuntimeTransport';
import type { InitializeResult, McpTransportOptions } from './mcpRuntimeTransport';

type PendingSseResponse = {
  resolve: (value: JsonRpcMessage) => void;
  reject: (error: Error) => void;
};

type LegacySseConnection = {
  endpoint: string;
  request: (payload: JsonRpcRequest | JsonRpcNotification, expectsResponse: boolean) => Promise<JsonRpcMessage | null>;
  close: () => void;
};

function decodeText(bytes: Uint8Array) {
  return new TextDecoder().decode(bytes);
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function consumeSseStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: string) => void
) {
  const reader = stream.getReader();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decodeText(value);
      const normalized = buffer.replace(/\r\n/g, '\n');
      const parts = normalized.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        if (!part.trim()) continue;
        for (const event of parseSseEvents(part + '\n\n')) {
          onEvent(event.event, event.data);
        }
      }
    }

    if (buffer.trim()) {
      for (const event of parseSseEvents(buffer + '\n\n')) {
        onEvent(event.event, event.data);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function openLegacySseConnection(options: McpTransportOptions): Promise<LegacySseConnection> {
  const fetchImpl = getFetchImpl(options.fetchImpl);
  const streamController = new AbortController();
  const endpointDeferred = createDeferred<string>();
  const pending = new Map<string, PendingSseResponse>();

  const response = await fetchWithMcpProxyFallback(options.server.url, {
    method: 'GET',
    headers: buildServerHeaders(options.server, {
      ...(await resolveMcpAuthorizationHeader(options.server, options.fetchImpl)),
      Accept: 'text/event-stream'
    }),
    signal: streamController.signal
  }, fetchImpl);

  if (!response.ok || !response.body) {
    throw new Error(`连接 MCP SSE 服务失败：HTTP ${response.status}`);
  }

  void consumeSseStream(response.body, (eventName, data) => {
    if (eventName === 'endpoint') {
      endpointDeferred.resolve(new URL(data.trim(), options.server.url).toString());
      return;
    }
    if (eventName !== 'message') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    const dispatch = (entry: unknown) => {
      const message = parseJsonRpcMessage(entry);
      if (!message?.id) return;
      const key = String(message.id);
      const pendingEntry = pending.get(key);
      if (!pendingEntry) return;
      pending.delete(key);
      pendingEntry.resolve(message);
    };

    if (Array.isArray(parsed)) {
      parsed.forEach(dispatch);
      return;
    }
    dispatch(parsed);
  }).catch((error) => {
    const message = error instanceof Error ? error : new Error('SSE 连接中断。');
    pending.forEach((entry) => entry.reject(message));
    pending.clear();
  });

  const endpoint = await withTimeout(
    endpointDeferred.promise,
    options.timeoutMs,
    `等待 MCP SSE 服务 ${options.server.name} 下发 endpoint`
  );

  const request = async (
    payload: JsonRpcRequest | JsonRpcNotification,
    expectsResponse: boolean
  ): Promise<JsonRpcMessage | null> => {
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(
      () => controller.abort(createTimeoutError(`调用 MCP SSE 服务 ${options.server.name}`, options.timeoutMs)),
      options.timeoutMs
    );
    const deferred = expectsResponse && 'id' in payload ? createDeferred<JsonRpcMessage>() : null;

    if (expectsResponse && deferred && 'id' in payload) {
      pending.set(String(payload.id), deferred);
    }

    try {
      const postResponse = await fetchWithMcpProxyFallback(endpoint, {
        method: 'POST',
        headers: buildServerHeaders(options.server, {
          ...(await resolveMcpAuthorizationHeader(options.server, options.fetchImpl)),
          'Content-Type': 'application/json'
        }),
        body: JSON.stringify(payload),
        signal: controller.signal
      }, fetchImpl);

      if (!postResponse.ok) {
        const errorText = await postResponse.text().catch(() => '');
        throw new Error(`调用 MCP SSE 服务失败：HTTP ${postResponse.status}${errorText ? ` · ${errorText.trim()}` : ''}`);
      }

      const contentType = postResponse.headers.get('content-type')?.toLowerCase() ?? '';
      if (expectsResponse && contentType.includes('application/json')) {
        const parsed = await postResponse.json().catch(() => null);
        return ensureSuccessMessage(findResponseMessage(parsed, (payload as JsonRpcRequest).id), `调用 MCP SSE 服务 ${options.server.name}`);
      }

      if (!expectsResponse || !deferred) {
        return null;
      }

      return ensureSuccessMessage(
        await withTimeout(deferred.promise, options.timeoutMs, `等待 MCP SSE 服务 ${options.server.name} 返回结果`),
        `调用 MCP SSE 服务 ${options.server.name}`
      );
    } finally {
      globalThis.clearTimeout(timeoutId);
      if (expectsResponse && 'id' in payload) {
        pending.delete(String(payload.id));
      }
    }
  };

  return {
    endpoint,
    request,
    close: () => {
      streamController.abort();
      pending.forEach((entry) => entry.reject(new Error('MCP SSE 连接已关闭。')));
      pending.clear();
    }
  };
}

export async function initializeLegacySseConnection(options: McpTransportOptions) {
  const connection = await openLegacySseConnection(options);
  try {
    const initializeResponse = ensureSuccessMessage(
      await connection.request({
        jsonrpc: '2.0',
        id: createRpcId(),
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: MCP_CLIENT_INFO
        }
      }, true),
      `初始化 MCP SSE 服务 ${options.server.name}`
    );

    await connection.request({
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    }, false);

    return {
      connection,
      protocolVersion:
        typeof (initializeResponse.result as InitializeResult | undefined)?.protocolVersion === 'string'
          ? ((initializeResponse.result as InitializeResult).protocolVersion as string)
          : MCP_PROTOCOL_VERSION
    };
  } catch (error) {
    connection.close();
    throw error;
  }
}
