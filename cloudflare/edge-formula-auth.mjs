// Optional extension access is separate from the website's cookie APIs.
// This feature is disabled unless explicitly enabled in runtime configuration.
import {EdgeStore, EdgeError, edgeJSON, hashToken, requireSameOrigin, sessionUser} from './edge-auth.mjs';

const EXTENSION = /^[a-p]{32}$/;
const RANDOM = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const SCOPE = 'formula:analyze';
const PAIR_SECONDS = 600;
const TOKEN_SECONDS = 1200;
const API_PREFIX = '/api/extension/';
const EXTENSION_POSTS = new Set(['pair/start', 'pair/token', 'papers', 'explain', 'revoke']);
const WEBSITE_ROUTES = new Set(['pair/info', 'pair/approve']);
const encoder = new TextEncoder();

class FormulaAccessError extends Error {
  constructor(status, message) {super(message); this.status = status;}
}

function extensionOrigin(request) {
  const origin = request.headers.get('origin') || '';
  const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  return match ? {origin, extensionId: match[1]} : null;
}

function responseCORS(response, source) {
  if (!source) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', source.origin);
  headers.set('Vary', 'Origin');
  // Credentialed CORS is deliberately absent. Extension calls use only their
  // scoped bearer; browser cookies never authorize these endpoints.
  headers.delete('Access-Control-Allow-Credentials');
  return new Response(response.body, {status: response.status, headers});
}

function publicOrigin(request, env) {
  let url;
  try {url = new URL(env.PUBLIC_ORIGIN);} catch {throw new FormulaAccessError(503, 'Extension access is unavailable.');}
  if (url.protocol !== 'https:' || url.origin !== env.PUBLIC_ORIGIN || url.pathname !== '/' ||
      url.username || url.password || url.port || url.search || url.hash || new URL(request.url).origin !== url.origin) {
    throw new FormulaAccessError(403, 'Use the main Easy ArXiv website.');
  }
  return url.origin;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function formulaCodeChallenge(verifier) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function jsonBody(request, allowed) {
  if ((request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new FormulaAccessError(415, 'Use a JSON request.');
  }
  const maximum = 4096;
  if (Number(request.headers.get('content-length')) > maximum) throw new FormulaAccessError(413, 'This connection request is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new FormulaAccessError(422, 'Include a connection request.');
  let length = 0, text = '';
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let value;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) {await reader.cancel(); throw new FormulaAccessError(413, 'This connection request is too large.');}
      text += decoder.decode(next.value, {stream: true});
    }
    text += decoder.decode();
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof FormulaAccessError) throw error;
    throw new FormulaAccessError(422, 'Include valid JSON connection details.');
  } finally {reader.releaseLock();}
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new FormulaAccessError(422, 'Include valid connection details.');
  }
  return value;
}

function pairId(value) {
  if (typeof value !== 'string' || !RANDOM.test(value)) throw new FormulaAccessError(422, 'This connection request is invalid or expired.');
  return value;
}

async function cleanup(store, seconds) {
  await store.query('DELETE FROM formula_pairings WHERE expires<=?', [seconds], 'run');
  await store.query('DELETE FROM formula_extension_tokens WHERE expires<=?', [seconds], 'run');
}

async function parentSession(request, store, seconds) {
  // Only the first-party approval request carries this HttpOnly cookie. The
  // extension never sees it; subsequent checks join stored hashes in D1.
  const pieces = (request.headers.get('cookie') || '').split(';');
  const entry = pieces.find(piece => piece.slice(0, piece.indexOf('=')).trim() === 'easy_arxiv_session');
  const token = entry ? entry.slice(entry.indexOf('=') + 1).trim() : '';
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
  const hash = await hashToken(token);
  const row = await store.query('SELECT expires FROM edge_sessions WHERE token_hash=? AND expires>?', [hash, seconds]);
  return row ? {hash, expires: row.expires} : null;
}

async function extensionIdentity(request, source, store, seconds) {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') || '')?.[1];
  if (!token) throw new FormulaAccessError(401, 'Connect Formula Lens to Easy ArXiv before using article analysis.');
  const row = await store.query(`SELECT grant.owner,grant.extension_id FROM formula_extension_tokens AS grant
    JOIN edge_sessions AS parent ON parent.token_hash=grant.parent_session_hash
    WHERE grant.token_hash=? AND grant.expires>? AND grant.scope=? AND parent.expires>?`,
    [await hashToken(token), seconds, SCOPE, seconds]);
  if (!row || row.extension_id !== source.extensionId) throw new FormulaAccessError(401, 'This extension connection expired. Connect again.');
  return {owner: row.owner, extensionId: row.extension_id};
}

export async function handleFormulaExtension(request, env, context = {},
    {handleAI = null, isSafeAIError = () => false} = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(API_PREFIX)) return null;
  const route = url.pathname.slice(API_PREFIX.length);
  const source = extensionOrigin(request);
  const finish = response => responseCORS(response, source);
  if (env.FORMULA_AI_ENABLED !== 'true') return finish(edgeJSON({detail: 'Article analysis is not enabled.'}, 404));
  try {
    const origin = publicOrigin(request, env);
    if (!EXTENSION_POSTS.has(route) && !WEBSITE_ROUTES.has(route)) return finish(edgeJSON({detail: 'Not found.'}, 404));
    if (request.method === 'OPTIONS') {
      const wanted = (request.headers.get('access-control-request-headers') || '').toLowerCase()
        .split(',').map(value => value.trim()).filter(Boolean);
      if (!source || !EXTENSION_POSTS.has(route) || request.headers.get('access-control-request-method') !== 'POST' ||
          wanted.some(name => !['content-type', 'authorization'].includes(name))) {
        throw new FormulaAccessError(403, 'This extension request is not allowed.');
      }
      return finish(new Response(null, {status: 204, headers: {
        'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '300', 'Cache-Control': 'no-store'}}));
    }
    const method = route === 'pair/info' ? 'GET' : 'POST';
    if (request.method !== method) return finish(edgeJSON({detail: 'Method not allowed.'}, 405, {Allow: method}));
    if (EXTENSION_POSTS.has(route) && !source) throw new FormulaAccessError(403, 'Start this action from Formula Lens.');
    if (WEBSITE_ROUTES.has(route)) requireSameOrigin(request, env, {sameOriginGet: route === 'pair/info'});
    const store = context.store || new EdgeStore(env.DB);
    const now = context.now ? context.now() : Date.now();
    const seconds = Math.floor(now / 1000);
    if (route === 'pair/start') {
      const data = await jsonBody(request, ['extensionId', 'challenge']);
      if (typeof data.extensionId !== 'string' || !EXTENSION.test(data.extensionId) || data.extensionId !== source.extensionId ||
          typeof data.challenge !== 'string' || !RANDOM.test(data.challenge)) {
        throw new FormulaAccessError(422, 'Include valid extension connection details.');
      }
      await cleanup(store, seconds);
      const id = randomToken(), expires = seconds + PAIR_SECONDS;
      const created = await store.query(`INSERT INTO formula_pairings(pair_id,extension_id,challenge,expires,created_at)
        SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM formula_pairings WHERE expires>?)<256
        AND (SELECT COUNT(*) FROM formula_pairings WHERE extension_id=? AND expires>?)<4 RETURNING pair_id`,
        [id, source.extensionId, data.challenge, expires, seconds, seconds, source.extensionId, seconds]);
      if (!created) throw new FormulaAccessError(429, 'Too many connection requests. Wait for an earlier request to expire.');
      return finish(edgeJSON({pairId: id, authorizeUrl: `${origin}/extension-connect#pairId=${id}`, expiresAt: expires * 1000}));
    }
    if (route === 'pair/info') {
      const id = pairId(url.searchParams.get('pairId'));
      const row = await store.query('SELECT extension_id,owner,expires FROM formula_pairings WHERE pair_id=? AND expires>?', [id, seconds]);
      if (!row) throw new FormulaAccessError(410, 'This connection request expired. Start again from Formula Lens.');
      const user = await sessionUser(request, env, {now: () => now});
      return edgeJSON({pairId: id, extensionId: row.extension_id, expiresAt: row.expires * 1000,
        approved: Boolean(row.owner), authenticated: Boolean(user), user});
    }
    if (route === 'pair/approve') {
      const user = await sessionUser(request, env, {now: () => now});
      if (!user) throw new FormulaAccessError(401, 'Sign in with ORCID before connecting Formula Lens.');
      const parent = await parentSession(request, store, seconds);
      if (!parent) throw new FormulaAccessError(401, 'Sign in with ORCID before connecting Formula Lens.');
      const data = await jsonBody(request, ['pairId']), id = pairId(data.pairId);
      const approved = await store.query(`UPDATE formula_pairings SET owner=?,approved_at=?,parent_session_hash=?
        WHERE pair_id=? AND expires>? AND owner IS NULL RETURNING extension_id`, [user.orcid, seconds, parent.hash, id, seconds]);
      if (!approved) {
        const previous = await store.query('SELECT owner FROM formula_pairings WHERE pair_id=? AND expires>?', [id, seconds]);
        if (previous?.owner !== user.orcid) throw new FormulaAccessError(410, 'This connection request expired or was already handled.');
      }
      return edgeJSON({approved: true});
    }
    if (route === 'pair/token') {
      const data = await jsonBody(request, ['pairId', 'verifier']), id = pairId(data.pairId);
      if (typeof data.verifier !== 'string' || !VERIFIER.test(data.verifier)) throw new FormulaAccessError(422, 'Include a valid proof for this connection.');
      const challenge = await formulaCodeChallenge(data.verifier);
      const row = await store.query(`SELECT pair.owner,parent.expires AS parent_expires FROM formula_pairings AS pair
        LEFT JOIN edge_sessions AS parent ON parent.token_hash=pair.parent_session_hash AND parent.expires>?
        WHERE pair.pair_id=? AND pair.extension_id=? AND pair.challenge=? AND pair.expires>?`,
        [seconds, id, source.extensionId, challenge, seconds]);
      if (!row) throw new FormulaAccessError(400, 'This connection proof is invalid or expired.');
      if (!row.owner) return finish(edgeJSON({status: 'pending'}, 202));
      if (!row.parent_expires) throw new FormulaAccessError(401, 'The approving website session expired. Start a new connection.');
      // One DELETE RETURNING wins even if two isolates poll simultaneously.
      const consumed = await store.query(`DELETE FROM formula_pairings WHERE pair_id=? AND extension_id=?
        AND challenge=? AND owner IS NOT NULL AND expires>?
        AND EXISTS(SELECT 1 FROM edge_sessions WHERE token_hash=formula_pairings.parent_session_hash AND expires>?)
        RETURNING owner,parent_session_hash`, [id, source.extensionId, challenge, seconds, seconds]);
      if (!consumed) throw new FormulaAccessError(400, 'This connection request was already used.');
      const accessToken = randomToken(), expires = Math.min(seconds + TOKEN_SECONDS, row.parent_expires);
      const created = await store.query(`INSERT INTO formula_extension_tokens(token_hash,owner,extension_id,scope,expires,created_at,parent_session_hash)
        SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM formula_extension_tokens WHERE expires>?)<1024
        AND (SELECT COUNT(*) FROM formula_extension_tokens WHERE owner=? AND expires>?)<8 RETURNING token_hash`,
        [await hashToken(accessToken), consumed.owner, source.extensionId, SCOPE, expires, seconds,
          consumed.parent_session_hash, seconds, consumed.owner, seconds]);
      if (!created) throw new FormulaAccessError(429, 'Too many active connections. Disconnect an earlier connection or wait for it to expire.');
      return finish(edgeJSON({accessToken, expiresAt: expires * 1000}));
    }
    const identity = await extensionIdentity(request, source, store, seconds);
    if (route === 'revoke') {
      const token = request.headers.get('authorization').slice(7);
      await store.query('DELETE FROM formula_extension_tokens WHERE token_hash=?', [await hashToken(token)], 'run');
      return finish(edgeJSON({disconnected: true}));
    }
    if (!handleAI) throw new FormulaAccessError(503, 'Article analysis is temporarily unavailable.');
    return finish(await handleAI(request, env, {...context, store}, identity) || edgeJSON({detail: 'Not found.'}, 404));
  } catch (error) {
    const safe = error instanceof FormulaAccessError || error instanceof EdgeError || isSafeAIError(error);
    const status = safe && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
    return finish(edgeJSON({detail: safe && status !== 503 ? error.message : 'Extension access is temporarily unavailable. Please try again.'}, status));
  }
}
