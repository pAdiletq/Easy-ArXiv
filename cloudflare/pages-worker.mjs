// Cloudflare Pages advanced-mode Worker. BACKEND_ORIGIN is a runtime binding,
// never a value substituted into the browser bundle during the static build.
const PUBLIC_ORIGIN_HEADER = 'x-easy-arxiv-public-origin';
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

export function backendOrigin(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        parsed.port || parsed.search || parsed.hash || parsed.pathname !== '/' ||
        (value !== parsed.origin && value !== parsed.origin + '/') ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.run\.app$/.test(parsed.hostname)) return null;
    return parsed.origin;
  } catch { return null; }
}

export function isBackendRequest(url) {
  return url.pathname === '/api' || url.pathname.startsWith('/api/') ||
    url.pathname === '/auth' || url.pathname.startsWith('/auth/') ||
    (url.pathname === '/' && ['code', 'state', 'error'].some(key => url.searchParams.has(key)));
}

function noStore(headers) {
  headers.set('cache-control', 'private, no-store');
  headers.set('cdn-cache-control', 'no-store');
  headers.set('cloudflare-cdn-cache-control', 'no-store');
  headers.set('pragma', 'no-cache');
  headers.set('expires', '0');
  headers.delete('etag'); headers.delete('last-modified'); headers.delete('age');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
}

function unavailable() {
  const headers = new Headers({'content-type': 'application/json; charset=utf-8'});
  noStore(headers);
  return new Response(JSON.stringify({error: 'The research service is temporarily unavailable. Please try again shortly.'}),
    {status: 503, headers});
}

function responseHeaders(upstream, publicOrigin, origin) {
  const headers = new Headers();
  for (const [name, value] of upstream.headers) {
    if (name !== 'set-cookie' && !HOP_HEADERS.has(name)) headers.append(name, value);
  }
  // Set-Cookie must remain separate, especially when OAuth both creates a
  // session and deletes the temporary state cookie in one redirect response.
  const cookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() :
    typeof upstream.headers.getAll === 'function' ? upstream.headers.getAll('Set-Cookie') :
    upstream.headers.has('set-cookie') ? [upstream.headers.get('set-cookie')] : [];
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  const location = headers.get('location');
  if (location) {
    try {
      const destination = new URL(location, origin);
      if (destination.origin === origin) {
        headers.set('location', publicOrigin + destination.pathname + destination.search + destination.hash);
      }
    } catch {
      headers.delete('location');
    }
  }
  noStore(headers);
  return headers;
}

export async function proxy(request, env, fetchUpstream = fetch) {
  const origin = backendOrigin(env.BACKEND_ORIGIN);
  if (!origin) return unavailable();
  const url = new URL(request.url);
  const target = new URL(origin);
  target.pathname = url.pathname;
  target.search = url.search;
  const headers = new Headers(request.headers);
  const connectionNames = (headers.get('connection') || '').split(',').map(name => name.trim().toLowerCase());
  for (const name of [...headers.keys()]) {
    if (HOP_HEADERS.has(name) || connectionNames.includes(name) || name === 'host' ||
        name === 'forwarded' || name.startsWith('x-forwarded-') || name === 'x-real-ip' ||
        name === PUBLIC_ORIGIN_HEADER) headers.delete(name);
  }
  // This informational value is derived here, never accepted from a caller.
  // Backend security uses its own configured PUBLIC_ORIGIN, not this header.
  headers.set(PUBLIC_ORIGIN_HEADER, url.origin);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  try {
    const original = new Request(target, request);
    const outgoing = new Request(original, {headers, redirect: 'manual', signal: controller.signal});
    const upstream = await fetchUpstream(outgoing, {cache: 'no-store'});
    if (upstream.status >= 500) {
      // Do not publish upstream exception pages, service details, or errors
      // that might contain credentials. Do not log OAuth query parameters.
      await upstream.body?.cancel();
      return unavailable();
    }
    return new Response(upstream.body, {status: upstream.status, statusText: upstream.statusText,
      headers: responseHeaders(upstream, url.origin, origin)});
  } catch {
    return unavailable();
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (isBackendRequest(url)) return proxy(request, env);
    // All static HTML, CSS, JS and image responses are independent of Python.
    return env.ASSETS.fetch(request);
  },
};
