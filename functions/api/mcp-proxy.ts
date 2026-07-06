// Same-origin MCP relay, deployed as a Cloudflare Pages Function.
//
// Browser pages cannot reach MCP servers (or their OAuth endpoints) that do
// not answer CORS preflights, so the web client retries those requests here:
// `/api/mcp-proxy?target=<https url>` forwards the method, safe headers, and
// body to the target and streams the response back. Same-origin requests
// never preflight, which is the whole point.
//
// Guards: https-only targets, a marker header the web client sets on proxy
// requests only, and an Origin check when the browser provides one. This
// keeps the relay scoped to its own deployment rather than an open proxy.

const MARKER_HEADER = 'x-polaris-mcp-proxy';

const STRIPPED_REQUEST_HEADERS = new Set([
  MARKER_HEADER,
  'host',
  'origin',
  'referer',
  'cookie',
  'connection',
  'content-length',
  'accept-encoding',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'expect'
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'connection',
  'transfer-encoding',
  'keep-alive',
  'content-encoding',
  'content-length',
  'alt-svc'
]);

function rejection(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function shouldStripRequestHeader(key: string) {
  const lower = key.toLowerCase();
  if (STRIPPED_REQUEST_HEADERS.has(lower)) return true;
  return lower.startsWith('cf-') || lower.startsWith('x-forwarded-') || lower.startsWith('sec-');
}

export const onRequest = async (context: { request: Request }): Promise<Response> => {
  const request = context.request;
  const requestUrl = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  const origin = request.headers.get('origin');
  if (origin && origin !== requestUrl.origin) {
    return rejection(403, 'Cross-origin use of the MCP proxy is not allowed.');
  }
  if (request.headers.get(MARKER_HEADER) !== '1') {
    return rejection(403, 'Missing MCP proxy marker header.');
  }

  const targetText = requestUrl.searchParams.get('target') ?? '';
  let target: URL;
  try {
    target = new URL(targetText);
  } catch {
    return rejection(400, 'Invalid target URL.');
  }
  if (target.protocol !== 'https:') {
    return rejection(400, 'Only https targets are allowed.');
  }
  if (target.origin === requestUrl.origin) {
    return rejection(400, 'Refusing to proxy to this origin.');
  }

  const forwardHeaders = new Headers();
  request.headers.forEach((value, key) => {
    if (!shouldStripRequestHeader(key)) {
      forwardHeaders.set(key, value);
    }
  });

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      method: request.method,
      headers: forwardHeaders,
      body: hasBody ? request.body : undefined,
      redirect: 'follow'
    });
  } catch {
    return rejection(502, 'The MCP proxy could not reach the target server.');
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders
  });
};
