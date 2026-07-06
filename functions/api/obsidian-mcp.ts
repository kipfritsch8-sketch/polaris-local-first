// Obsidian MCP bridge, deployed as a Cloudflare Pages Function.
//
// A stateless streamable-HTTP MCP server that translates MCP tool calls into
// Obsidian Local REST API requests (the community plugin running inside the
// user's desktop Obsidian, exposed through a tunnel). The vault location and
// credential are not stored here — every request carries them either as
// headers (how the Polaris MCP client is configured, since its editor has a
// custom-headers UI):
//
//   X-Obsidian-Base-Url: https://<tunnel-host>          (the tunneled plugin)
//   X-Obsidian-Api-Key:  <Local REST API plugin key>
//
// ...or, for MCP clients whose "add a server" flow only accepts a bare URL
// (e.g. Claude Desktop's custom connector dialog), as query parameters on
// the endpoint URL itself: `?base=<tunnel-host>&key=<plugin-key>`. Headers
// take precedence when both are present. The query-param form puts the key
// in the URL (visible in that client's saved config and in this Function's
// request logs) — acceptable for a single-user bridge, but headers are
// preferable whenever the client supports them.
//
// Being same-origin with the web app, this endpoint needs no CORS handling.

const BASE_URL_HEADER = 'x-obsidian-base-url';
const API_KEY_HEADER = 'x-obsidian-api-key';
const BASE_URL_QUERY_PARAM = 'base';
const API_KEY_QUERY_PARAM = 'key';
const PROTOCOL_VERSION = '2025-03-26';

type JsonRpcId = string | number | null;

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const TOOLS = [
  {
    name: 'obsidian_search',
    description: 'Search every note in the Obsidian vault for a text query and return matching snippets with their file paths.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for.' },
        context_length: { type: 'number', description: 'Characters of context around each match. Default 120.' }
      },
      required: ['query']
    }
  },
  {
    name: 'obsidian_read_note',
    description: 'Read the full markdown content of one note in the Obsidian vault.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative note path, e.g. "Projects/polaris.md".' }
      },
      required: ['path']
    }
  },
  {
    name: 'obsidian_list_files',
    description: 'List files and folders in a folder of the Obsidian vault. Folders end with "/".',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative folder path. Empty or omitted for the vault root.' }
      }
    }
  },
  {
    name: 'obsidian_write_note',
    description: 'Create a new note or fully replace an existing note in the Obsidian vault.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative note path to create or overwrite.' },
        content: { type: 'string', description: 'Markdown content for the note.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'obsidian_append_note',
    description: 'Append markdown to the end of an existing note (creates the note when missing).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative note path.' },
        content: { type: 'string', description: 'Markdown to append.' }
      },
      required: ['path', 'content']
    }
  }
];

function jsonRpcResponse(id: JsonRpcId, result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function jsonRpcError(id: JsonRpcId, code: number, message: string) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function encodeVaultPath(path: string) {
  return path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

type ObsidianTarget = { baseUrl: string; apiKey: string };

async function obsidianFetch(
  target: ObsidianTarget,
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {}
) {
  const url = `${target.baseUrl.replace(/\/+$/, '')}${path}`;
  return await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      // Keeps free ngrok tunnels from answering with their browser interstitial.
      'ngrok-skip-browser-warning': '1',
      'User-Agent': 'polaris-obsidian-bridge/1.0',
      ...(init.headers ?? {})
    }
  });
}

async function describeFailure(response: Response, action: string) {
  const body = await response.text().catch(() => '');
  return textResult(
    `${action} failed: HTTP ${response.status}${body ? ` · ${body.trim().slice(0, 300)}` : ''}`,
    true
  );
}

async function runSearch(target: ObsidianTarget, args: Record<string, unknown>): Promise<ToolResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return textResult('The "query" argument is required.', true);
  const contextLength = typeof args.context_length === 'number' && args.context_length > 0
    ? Math.floor(args.context_length)
    : 120;

  const response = await obsidianFetch(
    target,
    `/search/simple/?query=${encodeURIComponent(query)}&contextLength=${contextLength}`,
    { method: 'POST' }
  );
  if (!response.ok) return await describeFailure(response, 'Search');

  const results = await response.json().catch(() => null) as Array<{
    filename?: string;
    score?: number;
    matches?: Array<{ context?: string }>;
  }> | null;
  if (!Array.isArray(results) || !results.length) {
    return textResult(`No matches for "${query}".`);
  }

  const lines = results.slice(0, 20).map((entry) => {
    const snippets = (entry.matches ?? [])
      .slice(0, 3)
      .map((match) => (match.context ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .map((context) => `  · ${context}`);
    return [`${entry.filename ?? '(unknown file)'}`, ...snippets].join('\n');
  });
  return textResult(`Found ${results.length} matching note(s):\n\n${lines.join('\n\n')}`);
}

async function runReadNote(target: ObsidianTarget, args: Record<string, unknown>): Promise<ToolResult> {
  const path = typeof args.path === 'string' ? args.path.trim() : '';
  if (!path) return textResult('The "path" argument is required.', true);

  const response = await obsidianFetch(target, `/vault/${encodeVaultPath(path)}`, {
    method: 'GET',
    headers: { Accept: 'text/markdown' }
  });
  if (!response.ok) return await describeFailure(response, `Reading "${path}"`);
  const content = await response.text();
  return textResult(content || '(empty note)');
}

async function runListFiles(target: ObsidianTarget, args: Record<string, unknown>): Promise<ToolResult> {
  const rawPath = typeof args.path === 'string' ? args.path.trim().replace(/^\/+|\/+$/g, '') : '';
  const suffix = rawPath ? `/vault/${encodeVaultPath(rawPath)}/` : '/vault/';

  const response = await obsidianFetch(target, suffix, { method: 'GET' });
  if (!response.ok) return await describeFailure(response, `Listing "${rawPath || '/'}"`);
  const payload = await response.json().catch(() => null) as { files?: string[] } | null;
  const files = Array.isArray(payload?.files) ? payload.files : [];
  if (!files.length) return textResult(`Folder "${rawPath || '/'}" is empty.`);
  return textResult(files.join('\n'));
}

async function runWriteNote(target: ObsidianTarget, args: Record<string, unknown>): Promise<ToolResult> {
  const path = typeof args.path === 'string' ? args.path.trim() : '';
  const content = typeof args.content === 'string' ? args.content : '';
  if (!path) return textResult('The "path" argument is required.', true);

  const response = await obsidianFetch(target, `/vault/${encodeVaultPath(path)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/markdown' },
    body: content
  });
  if (!response.ok) return await describeFailure(response, `Writing "${path}"`);
  return textResult(`Saved "${path}" (${content.length} characters).`);
}

async function runAppendNote(target: ObsidianTarget, args: Record<string, unknown>): Promise<ToolResult> {
  const path = typeof args.path === 'string' ? args.path.trim() : '';
  const content = typeof args.content === 'string' ? args.content : '';
  if (!path) return textResult('The "path" argument is required.', true);

  const response = await obsidianFetch(target, `/vault/${encodeVaultPath(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/markdown' },
    body: content
  });
  if (!response.ok) return await describeFailure(response, `Appending to "${path}"`);
  return textResult(`Appended ${content.length} characters to "${path}".`);
}

async function callTool(target: ObsidianTarget, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'obsidian_search': return await runSearch(target, args);
    case 'obsidian_read_note': return await runReadNote(target, args);
    case 'obsidian_list_files': return await runListFiles(target, args);
    case 'obsidian_write_note': return await runWriteNote(target, args);
    case 'obsidian_append_note': return await runAppendNote(target, args);
    default: return textResult(`Unknown tool "${name}".`, true);
  }
}

export const onRequest = async (context: { request: Request }): Promise<Response> => {
  const request = context.request;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }
  if (request.method === 'DELETE') {
    return new Response(null, { status: 204 });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let payload: { id?: JsonRpcId; method?: string; params?: Record<string, unknown> };
  try {
    payload = await request.json() as typeof payload;
  } catch {
    return jsonRpcError(null, -32700, 'Parse error');
  }

  const id = payload.id ?? null;
  const method = payload.method ?? '';

  // Notifications carry no id and expect no body.
  if (id === null && method.startsWith('notifications/')) {
    return new Response(null, { status: 202 });
  }

  const requestUrl = new URL(request.url);
  const baseUrl = request.headers.get(BASE_URL_HEADER)?.trim()
    || requestUrl.searchParams.get(BASE_URL_QUERY_PARAM)?.trim()
    || '';
  const apiKey = request.headers.get(API_KEY_HEADER)?.trim()
    || requestUrl.searchParams.get(API_KEY_QUERY_PARAM)?.trim()
    || '';
  if (!baseUrl || !apiKey) {
    return jsonRpcError(
      id,
      -32000,
      `Missing Obsidian connection info. Configure the MCP server with custom headers "${BASE_URL_HEADER}" / "${API_KEY_HEADER}", or (when the client only accepts a bare URL) append "?${BASE_URL_QUERY_PARAM}=<tunnel-url>&${API_KEY_QUERY_PARAM}=<api-key>" to this endpoint's URL.`
    );
  }
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('bad protocol');
  } catch {
    return jsonRpcError(id, -32000, `"${BASE_URL_HEADER}" is not a valid URL.`);
  }

  const target: ObsidianTarget = { baseUrl, apiKey };

  switch (method) {
    case 'initialize':
      return jsonRpcResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'Polaris Obsidian Bridge', version: '1.0.0' }
      });
    case 'ping':
      return jsonRpcResponse(id, {});
    case 'tools/list':
      return jsonRpcResponse(id, { tools: TOOLS });
    case 'tools/call': {
      const params = payload.params ?? {};
      const name = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? params.arguments as Record<string, unknown>
        : {};
      try {
        return jsonRpcResponse(id, await callTool(target, name, args));
      } catch (error) {
        return jsonRpcResponse(id, textResult(
          `The bridge could not reach the Obsidian Local REST API: ${error instanceof Error ? error.message : String(error)}. Is the tunnel on the computer still running?`,
          true
        ));
      }
    }
    default:
      return jsonRpcError(id, -32601, `Method "${method}" is not supported.`);
  }
};
