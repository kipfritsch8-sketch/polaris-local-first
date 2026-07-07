// Model provider relay, deployed as a Cloudflare Pages Function.
//
// The web client (`src/engines/chat-api/chatApiTransport.ts`,
// `shouldUseBrowserProviderRelay`) posts here instead of calling a model
// provider directly whenever the provider isn't the specially-cased
// Anthropic official endpoint — most providers' chat-completions endpoints
// either don't answer a browser CORS preflight at all, or the deployer
// would rather not expose the provider's key-bearing request straight from
// the page. This mirrors the reference Vercel handler at
// `api/provider-relay.ts` for the static-site deployment path: same request
// contract (`{ endpoint, headers, body }`), same target/header validation,
// same streamed-through response.
//
// Same-origin only: the request always comes from this same deployment's
// own frontend, so a foreign Origin header is rejected outright.

const FORBIDDEN_RELAY_HEADER_NAMES = new Set([
  'connection',
  'content-length',
  'host',
  'origin',
  'referer',
  'transfer-encoding'
]);

const PROVIDER_RELAY_AUTH_HEADER_NAMES = new Set([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'xi-api-key'
]);

const NON_RELAYABLE_PATH_HINTS = [
  'embedding',
  'embeddings',
  'image',
  'images',
  'audio',
  'speech',
  'transcription',
  'transcriptions',
  'moderation',
  'moderations',
  'upload',
  'uploads',
  'file',
  'files',
  'batch',
  'batches',
  'finetuning',
  'fine-tuning',
  'rerank',
  'reranking'
];

function isPrivateHostname(hostname: string) {
  const lower = hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!lower) return true;
  if (lower === 'localhost' || lower.endsWith('.local')) return true;
  if (lower === '::' || lower === '::1') return true;
  if (lower.includes(':') && (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:'))) {
    return true;
  }
  const ipv4 = lower.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
  }
  return false;
}

function isRelayablePath(pathname: string) {
  const normalized = pathname.replace(/\/+$/, '').toLowerCase();
  if (!normalized) return false;
  return !NON_RELAYABLE_PATH_HINTS.some((hint) => normalized.includes(hint));
}

function isAllowedRelayTarget(endpoint: string) {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (isPrivateHostname(parsed.hostname)) return false;
  return isRelayablePath(parsed.pathname);
}

function sanitizeRelayHeaders(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).filter(([rawKey, value]) => {
      if (typeof value !== 'string' || !value.trim()) return false;
      const key = rawKey.trim().toLowerCase();
      if (!key) return false;
      if (FORBIDDEN_RELAY_HEADER_NAMES.has(key)) return false;
      if (key.startsWith('x-forwarded-')) return false;
      return true;
    })
  );
}

function hasRelayAuthHeader(headers: Record<string, string>) {
  return Object.keys(headers).some((key) => PROVIDER_RELAY_AUTH_HEADER_NAMES.has(key.trim().toLowerCase()));
}

function errorResponse(status: number, message: string, type: string) {
  return new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export const onRequest = async (context: { request: Request }): Promise<Response> => {
  const request = context.request;
  const requestUrl = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  const origin = request.headers.get('origin');
  if (origin && origin !== requestUrl.origin) {
    return errorResponse(403, 'Cross-origin use of the provider relay is not allowed.', 'invalid_request');
  }

  if (request.method !== 'POST') {
    return errorResponse(405, 'Method not allowed', 'invalid_request');
  }

  let payload: { endpoint?: unknown; headers?: unknown; body?: unknown };
  try {
    payload = await request.json() as typeof payload;
  } catch {
    return errorResponse(400, 'Invalid JSON body.', 'invalid_request');
  }

  const endpoint = typeof payload.endpoint === 'string' ? payload.endpoint.trim() : '';
  if (!isAllowedRelayTarget(endpoint)) {
    return errorResponse(400, '当前 relay 只接受公开 HTTPS 的文本生成接口。', 'invalid_upstream');
  }

  const relayHeaders = sanitizeRelayHeaders(
    payload.headers && typeof payload.headers === 'object' && !Array.isArray(payload.headers)
      ? Object.fromEntries(
          Object.entries(payload.headers as Record<string, unknown>).map(([key, value]) => [key, String(value)])
        )
      : {}
  );
  if (!hasRelayAuthHeader(relayHeaders)) {
    return errorResponse(400, 'relay 请求缺少上游认证头。', 'missing_upstream_auth');
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(endpoint, {
      method: 'POST',
      headers: relayHeaders,
      body: JSON.stringify(payload.body ?? {})
    });
  } catch {
    return errorResponse(502, 'provider relay 请求失败。', 'relay_error');
  }

  const responseHeaders = new Headers({
    'Cache-Control': 'no-store, no-transform',
    'X-Accel-Buffering': 'no'
  });
  const contentType = upstreamResponse.headers.get('content-type');
  if (contentType) {
    responseHeaders.set('Content-Type', contentType);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: responseHeaders
  });
};
