// Account data stays in the D1 binding. Provider secrets/tokens never reach assets.
const SESSION_COOKIE = 'easy_arxiv_session';
const STATE_COOKIE = 'easy_arxiv_oauth_state';
const ORCID_ID = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;
const ARTICLE = /^(?:\d{4}\.\d{4,5}|[a-zA-Z][a-zA-Z.\-]+\/\d{7})(?:v[1-9]\d*)?$/;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const encoder = new TextEncoder();

export class EdgeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const EdgeHTTPError = EdgeError;
const unavailable = () => new EdgeHTTPError(503, 'Your account storage is temporarily unavailable. Please try again.');

export function edgeJSON(data, status = 200, headers = {}) {
  const result = new Headers(headers);
  result.set('Content-Type', 'application/json; charset=utf-8');
  result.set('Cache-Control', 'no-store');
  result.set('X-Content-Type-Options', 'nosniff');
  result.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return new Response(JSON.stringify(data), { status, headers: result });
}

export async function hashToken(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function equalState(left, right) {
  const a = encoder.encode(left), b = encoder.encode(right);
  if (a.length !== b.length) return false;
  if (typeof crypto.subtle.timingSafeEqual === 'function') return crypto.subtle.timingSafeEqual(a, b);
  // Standards-only fallback for test runtimes: HMAC verification compares the
  // fixed-length signatures inside WebCrypto, rather than a JS early-exit loop.
  const key = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const signature = await crypto.subtle.sign('HMAC', key, a);
  return crypto.subtle.verify('HMAC', key, signature, b);
}

function readCookie(request, name) {
  const pieces = (request.headers.get('cookie') || '').split(';');
  for (const piece of pieces) {
    const separator = piece.indexOf('=');
    if (separator >= 0 && piece.slice(0, separator).trim() === name) return piece.slice(separator + 1).trim();
  }
  return '';
}

function cookie(name, value, age) {
  return `${name}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;
}

function configuredOrigin(env) {
  let value;
  try { value = new URL(env.PUBLIC_ORIGIN); } catch { throw new EdgeHTTPError(503, 'The public site origin is not configured.'); }
  if (value.protocol !== 'https:' || value.username || value.password || value.search || value.hash
      || value.pathname !== '/' || value.origin !== env.PUBLIC_ORIGIN) {
    throw new EdgeHTTPError(503, 'The public site origin is not configured.');
  }
  return value.origin;
}

export function requireSameOrigin(request, env, { sameOriginGet = false } = {}) {
  const expected = configuredOrigin(env);
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  const trustedGet = sameOriginGet && request.method === 'GET' && fetchSite === 'same-origin';
  if (new URL(request.url).origin !== expected || (origin ? origin !== expected : !trustedGet) || fetchSite === 'cross-site') {
    throw new EdgeHTTPError(403, 'Use the account controls in Easy ArXiv.');
  }
}

function publicIdentity(user) {
  if (!user || !ORCID_ID.test(user.orcid || '')) return null;
  return { orcid: user.orcid, name: typeof user.name === 'string' && user.name ? user.name.slice(0, 300) : 'Researcher' };
}

export class EdgeStore {
  constructor(db) {
    if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') throw unavailable();
    // Read from the primary: replica lag must not permit OAuth-state replay or
    // resurrect a revoked session. D1 Sessions are per-request, not global state.
    this.db = typeof db.withSession === 'function' ? db.withSession('first-primary') : db;
  }
  async query(sql, values = [], method = 'first') {
    try { return await this.db.prepare(sql).bind(...values)[method](); }
    catch { throw unavailable(); }
  }
  async cleanup(nowMs = Date.now()) {
    const lease = await this.query(`INSERT INTO edge_maintenance(name,next_ms) VALUES('cleanup',?)
      ON CONFLICT(name) DO UPDATE SET next_ms=excluded.next_ms WHERE next_ms<=?
      RETURNING next_ms`, [nowMs + 3600000, nowMs]);
    if (!lease) return;
    const cutoffDay = new Date(nowMs - 3 * 86400000).toISOString().slice(0, 10);
    const seconds = Math.floor(nowMs / 1000);
    try {
      await this.db.batch([
        this.db.prepare('DELETE FROM edge_sessions WHERE expires<=?').bind(seconds),
        this.db.prepare('DELETE FROM edge_oauth_states WHERE expires<=?').bind(seconds),
        this.db.prepare('DELETE FROM edge_cache WHERE expires<=?').bind(nowMs),
        this.db.prepare('DELETE FROM edge_quota_reservations WHERE day<?').bind(cutoffDay),
        this.db.prepare('DELETE FROM edge_quota_users WHERE day<?').bind(cutoffDay),
        this.db.prepare('DELETE FROM edge_quota_totals WHERE day<?').bind(cutoffDay),
      ]);
    } catch { throw unavailable(); }
  }
  async probe() { await this.query('SELECT 1 AS ready'); await this.cleanup(); }
  async getSession(hash, now) {
    const row = await this.query('SELECT user_json FROM edge_sessions WHERE token_hash=? AND expires>?', [hash, now]);
    if (!row) return null;
    try { return publicIdentity(JSON.parse(row.user_json)); } catch { throw unavailable(); }
  }
  async createSession(hash, user, expires) {
    const identity = publicIdentity(user);
    if (!identity) throw new EdgeHTTPError(502, 'ORCID returned an invalid identity.');
    await this.query('INSERT INTO edge_sessions(token_hash,user_json,expires) VALUES(?,?,?)',
      [hash, JSON.stringify(identity), expires], 'run');
  }
  async deleteSession(hash) { await this.query('DELETE FROM edge_sessions WHERE token_hash=?', [hash], 'run'); }
  async createState(hash, expires) {
    await this.cleanup((expires - 600) * 1000);
    const row = await this.query(`INSERT INTO edge_oauth_states(state_hash,expires)
      SELECT ?,? WHERE (SELECT COUNT(*) FROM edge_oauth_states WHERE expires>?)<256
      RETURNING state_hash`, [hash, expires, expires - 600]);
    if (!row) throw new EdgeHTTPError(503, 'Sign-in is busy. Please try again in a moment.');
  }
  async consumeState(hash, now) {
    // DELETE RETURNING is atomic: two isolates cannot consume the same state.
    const row = await this.query('DELETE FROM edge_oauth_states WHERE state_hash=? RETURNING expires', [hash]);
    return !!row && row.expires > now;
  }
  async listSaved(owner, start = 0) {
    if (!Number.isInteger(start) || start < 0 || start > 100) throw new EdgeHTTPError(422, 'Choose a saved-paper offset from 0 to 100.');
    const result = await this.query('SELECT metadata,saved_at FROM edge_saved WHERE owner=? ORDER BY saved_at DESC,paper_id LIMIT 21 OFFSET ?', [owner, start], 'all');
    try {
      const papers = result.results.slice(0, 20).map(row => ({ ...JSON.parse(row.metadata), saved_at: row.saved_at }));
      const has_more = result.results.length > 20 && start + 20 < 100;
      return { papers, has_more, next_start: has_more ? start + 20 : null };
    }
    catch { throw unavailable(); }
  }
  async savePaper(owner, paper) {
    const metadata = JSON.stringify(paper);
    if (encoder.encode(metadata).byteLength > 16 * 1024) throw new EdgeHTTPError(413, 'This paper metadata is too large to save.');
    const row = await this.query(`INSERT INTO edge_saved(owner,paper_id,metadata,saved_at) VALUES(?,?,?,?)
      ON CONFLICT(owner,paper_id) DO UPDATE SET metadata=excluded.metadata RETURNING paper_id`,
      [owner, paper.id, metadata, new Date().toISOString()]);
    if (!row) throw new EdgeHTTPError(409, 'Your reading list has reached 100 papers. Remove a saved paper before adding another.');
    return paper;
  }
  async deleteSaved(owner, id) { await this.query('DELETE FROM edge_saved WHERE owner=? AND paper_id=?', [owner, id], 'run'); }
  async reserveAI(owner, day, userLimit, globalLimit) {
    if (!ORCID_ID.test(owner) || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isInteger(userLimit)
        || !Number.isInteger(globalLimit) || userLimit < 1 || userLimit > globalLimit || globalLimit > 1000) {
      throw new EdgeHTTPError(503, 'AI Quest limits are not configured.');
    }
    await this.cleanup();
    const row = await this.query(`INSERT INTO edge_quota_reservations(id,day,owner,user_limit,global_limit)
      VALUES(?,?,?,?,?) RETURNING id`, [crypto.randomUUID(), day, owner, userLimit, globalLimit]);
    return !!row;
  }
  async acquireArxivSlot(nowMs) {
    await this.cleanup(nowMs);
    const row = await this.query(`INSERT INTO edge_arxiv_schedule(name,next_ms) VALUES('arxiv',?)
      ON CONFLICT(name) DO UPDATE SET next_ms=MAX(next_ms,?)+3000 WHERE next_ms<=?
      RETURNING next_ms-3000 AS slot`, [nowMs + 3000, nowMs, nowMs + 15000]);
    if (!row) throw new EdgeHTTPError(503, 'Search is busy. Please try again in a moment.');
    return Math.max(0, row.slot - nowMs);
  }
}

export async function sessionUser(request, env, { now = () => Date.now() } = {}) {
  const store = new EdgeStore(env.DB);
  const token = readCookie(request, SESSION_COOKIE);
  if (!TOKEN.test(token)) return null;
  return store.getSession(await hashToken(token), Math.floor(now() / 1000));
}

function orcidSettings(env) {
  const present = [env.ORCID_CLIENT_ID, env.ORCID_CLIENT_SECRET, env.ORCID_REDIRECT_URI].map(Boolean);
  if (!present.some(Boolean)) return null;
  if (!present.every(Boolean)) throw new EdgeHTTPError(503, 'ORCID sign-in is not configured.');
  const expected = configuredOrigin(env);
  if (![`${expected}/auth/callback`, `${expected}/`].includes(env.ORCID_REDIRECT_URI)) {
    throw new EdgeHTTPError(503, 'ORCID sign-in is not configured.');
  }
  return { client_id: env.ORCID_CLIENT_ID, client_secret: env.ORCID_CLIENT_SECRET, redirect_uri: env.ORCID_REDIRECT_URI };
}

async function boundedJSON(message, maximum = 64 * 1024) {
  if (Number(message.headers.get('content-length')) > maximum) throw new EdgeHTTPError(413, 'This paper metadata is too large to save.');
  const reader = message.body?.getReader();
  if (!reader) throw new EdgeHTTPError(422, 'Include valid JSON paper metadata.');
  let length = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximum) { await reader.cancel(); throw new EdgeHTTPError(413, 'This paper metadata is too large to save.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new EdgeHTTPError(422, 'Include valid JSON paper metadata.'); }
}

export function normalizeSavedPaper(raw) {
  const invalid = () => { throw new EdgeHTTPError(422, 'Include valid arXiv paper metadata.'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  let source = raw.pdf_url || raw.pdf || raw.link || raw.id;
  if (typeof source !== 'string') return invalid();
  source = source.trim();
  let identifier;
  if (ARTICLE.test(source)) identifier = source;
  else {
    let url;
    try { url = new URL(source); } catch { return invalid(); }
    if (url.protocol !== 'https:' || !['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'].includes(url.hostname)
        || url.username || url.password || url.port || url.search || url.hash) return invalid();
    identifier = url.pathname.replace(/^\/(?:pdf|abs)\//, '').replace(/\.pdf$/, '');
    if (!/^\/(?:pdf|abs)\//.test(url.pathname) || !ARTICLE.test(identifier)) return invalid();
  }
  const title = raw.title, summary = raw.summary ?? raw.abstract ?? '', authors = raw.authors ?? [];
  if (typeof title !== 'string' || !title.trim() || title.length > 1000 || typeof summary !== 'string' || summary.length > 40000
      || !Array.isArray(authors) || authors.length > 2000 || authors.some(name => typeof name !== 'string' || !name.trim() || name.length > 300)) return invalid();
  const published = raw.published ?? '';
  if (typeof published !== 'string' || published.length > 40 || (published && !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(published))
      || (published && Number.isNaN(Date.parse(published)))) return invalid();
  const categories = raw.categories ?? [];
  if (!Array.isArray(categories) || categories.some(item => typeof item !== 'string')) return invalid();
  const category = raw.category || categories[0] || 'arXiv';
  if (typeof category !== 'string' || category.length > 80) return invalid();
  const trimmedSummary = summary.trim();
  const paper = { id: identifier.replace(/v\d+$/, ''), title: title.trim().replace(/\s+/g, ' '), summary: trimmedSummary.slice(0, 4000),
    authors: authors.slice(0, 20).map(name => name.trim().slice(0, 200)), published, pdf_url: `https://arxiv.org/pdf/${identifier}`,
    link: `https://arxiv.org/abs/${identifier}`, category };
  for (const [name, fallback] of [['summary_label', 'Abstract'], ['source_label', 'arXiv']]) {
    const value = raw[name] ?? fallback;
    if (typeof value !== 'string' || value.length > 80) return invalid();
    paper[name] = value;
  }
  if (trimmedSummary.length > 4000) paper.summary_label = 'Abstract excerpt';
  const keywords = raw.keywords ?? [];
  if (!Array.isArray(keywords) || keywords.length > 8 || keywords.some(word => typeof word !== 'string' || word.length > 100)) return invalid();
  paper.keywords = keywords;
  return paper;
}

function redirect(location, status = 303) {
  return new Response(null, { status, headers: { Location: location, 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });
}

export async function handleAuth(request, env, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const url = new URL(request.url), path = url.pathname;
  const callback = path === '/auth/callback' || (path === '/' && ['code', 'state', 'error'].some(key => url.searchParams.has(key)));
  if (!callback && !['/auth/login', '/auth/logout', '/api/session', '/api/saved'].includes(path) && !path.startsWith('/api/saved/')) return null;
  try {
    if (url.origin !== configuredOrigin(env)) throw new EdgeHTTPError(403, 'Use the production Easy ArXiv site to sign in.');
    const store = new EdgeStore(env.DB), seconds = Math.floor(now() / 1000);
    if (path === '/api/session' && request.method === 'GET') {
      const user = await sessionUser(request, env, { now });
      return edgeJSON({ authenticated: !!user, user });
    }
    if (path === '/auth/login' && request.method === 'GET') {
      const settings = orcidSettings(env);
      if (!settings) throw new EdgeHTTPError(503, 'ORCID sign-in is not configured. Search and read without an account.');
      const state = randomToken();
      await store.createState(await hashToken(state), seconds + 600);
      const params = new URLSearchParams({ client_id: settings.client_id, response_type: 'code', scope: '/authenticate',
        redirect_uri: settings.redirect_uri, state });
      const response = redirect(`https://orcid.org/oauth/authorize?${params}`, 302);
      response.headers.append('Set-Cookie', cookie(STATE_COOKIE, state, 600));
      return response;
    }
    if (callback && request.method === 'GET') {
      const settings = orcidSettings(env);
      if (!settings) throw new EdgeHTTPError(503, 'ORCID sign-in is not configured.');
      const state = url.searchParams.get('state') || '', browserState = readCookie(request, STATE_COOKIE);
      if (!TOKEN.test(state) || !TOKEN.test(browserState) || !await equalState(state, browserState)
          || !await store.consumeState(await hashToken(state), seconds)) {
        throw new EdgeHTTPError(400, 'This sign-in request expired. Please start ORCID sign-in again.');
      }
      if (url.searchParams.has('error')) {
        const response = redirect('/?auth=cancelled');
        response.headers.append('Set-Cookie', cookie(STATE_COOKIE, '', 0));
        return response;
      }
      const code = url.searchParams.get('code');
      if (!code || code.length > 2048) throw new EdgeHTTPError(400, 'This sign-in request expired. Please start ORCID sign-in again.');
      let user;
      try {
        const provider = await fetchImpl('https://orcid.org/oauth/token', { method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ ...settings, grant_type: 'authorization_code', code }),
          signal: AbortSignal.timeout(20000), redirect: 'error' });
        if (!provider.ok) throw new Error('Provider rejected sign-in');
        user = publicIdentity(await boundedJSON(provider, 65536));
        if (!user) throw new Error('Invalid provider identity');
      } catch { throw new EdgeHTTPError(502, 'ORCID sign-in could not be completed. Please try again.'); }
      const token = randomToken();
      await store.createSession(await hashToken(token), user, seconds + 86400);
      const response = redirect('/?auth=success');
      response.headers.append('Set-Cookie', cookie(SESSION_COOKIE, token, 86400));
      response.headers.append('Set-Cookie', cookie(STATE_COOKIE, '', 0));
      return response;
    }
    if (path === '/auth/logout' && request.method === 'POST') {
      requireSameOrigin(request, env);
      const token = readCookie(request, SESSION_COOKIE);
      if (TOKEN.test(token)) await store.deleteSession(await hashToken(token));
      return edgeJSON({ ok: true }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, '', 0) });
    }
    const user = await sessionUser(request, env, { now });
    if (!user) throw new EdgeHTTPError(401, 'Sign in with ORCID to access your saved papers.');
    if (path === '/api/saved' && request.method === 'GET') {
      const start = url.searchParams.get('start') ?? '0';
      if (!/^(?:0|[1-9]\d{0,2})$/.test(start) || Number(start) > 100) throw new EdgeHTTPError(422, 'Choose a saved-paper offset from 0 to 100.');
      return edgeJSON(await store.listSaved(user.orcid, Number(start)));
    }
    if (path === '/api/saved' && request.method === 'POST') {
      requireSameOrigin(request, env);
      const data = await boundedJSON(request), paper = normalizeSavedPaper(data?.paper);
      await store.savePaper(user.orcid, paper);
      return edgeJSON({ paper, saved: true });
    }
    if (path.startsWith('/api/saved/') && request.method === 'DELETE') {
      requireSameOrigin(request, env);
      let id;
      try { id = decodeURIComponent(path.slice('/api/saved/'.length)); } catch { throw new EdgeHTTPError(422, 'Include a valid arXiv paper identifier.'); }
      if (!ARTICLE.test(id)) throw new EdgeHTTPError(422, 'Include a valid arXiv paper identifier.');
      id = id.replace(/v\d+$/, '');
      await store.deleteSaved(user.orcid, id);
      return edgeJSON({ id, deleted: true });
    }
    return edgeJSON({ detail: 'Method not allowed.' }, 405);
  } catch (error) {
    return edgeJSON({ detail: error instanceof EdgeHTTPError ? error.message : unavailable().message },
      error instanceof EdgeHTTPError ? error.status : 503);
  }
}
