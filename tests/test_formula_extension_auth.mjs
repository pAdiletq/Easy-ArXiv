import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {SQLiteD1} from './helpers/d1.mjs';
import {EdgeStore, handleAuth, hashToken} from '../cloudflare/edge-auth.mjs';
import {formulaCodeChallenge, handleFormulaExtension} from '../cloudflare/edge-formula-auth.mjs';
import {handleRequest} from '../cloudflare/edge-worker.mjs';

const origin = 'https://easy-arxiv.pages.dev';
const extensionA = 'a'.repeat(32), extensionB = 'b'.repeat(32);
const browserToken = 'synthetic-test-browser-session-'.padEnd(43, 'x');
const verifier = 'synthetic-test-pkce-verifier-'.padEnd(64, 'v');
const owner = '0000-0001-2345-6789';
const extensionOrigin = id => 'chrome-extension://' + id;
const request = (path, options = {}) => new Request(origin + '/api/extension/' + path, options);
const post = (path, value, id = extensionA, headers = {}) => request(path, {method: 'POST',
  headers: {'content-type': 'application/json', origin: extensionOrigin(id), ...headers}, body: JSON.stringify(value)});
const websitePost = (path, value, cookie = browserToken, headers = {}) => request(path, {method: 'POST',
  headers: {'content-type': 'application/json', origin, cookie: 'easy_arxiv_session=' + cookie, ...headers}, body: JSON.stringify(value)});

function setup(t) {
  const DB = new SQLiteD1(); t.after(() => DB.close());
  let clock = Date.now();
  const env = {DB, PUBLIC_ORIGIN: origin, FORMULA_AI_ENABLED: 'true', ASSETS: {fetch: async () => new Response('test page')}};
  const context = {store: new EdgeStore(DB), now: () => clock};
  return {env, context, advance: ms => {clock += ms;}, clock: () => clock};
}
async function signIn(h, account = owner, token = browserToken) {
  await h.context.store.createSession(await hashToken(token), {orcid: account, name: 'Synthetic Reader'}, Math.floor(h.clock() / 1000) + 3600);
}
async function start(h, id = extensionA) {
  const response = await handleFormulaExtension(post('pair/start', {extensionId: id, challenge: await formulaCodeChallenge(verifier)}, id), h.env, h.context);
  assert.equal(response.status, 200); return response.json();
}
async function approve(h, pairId, cookie = browserToken) {
  return handleFormulaExtension(websitePost('pair/approve', {pairId}, cookie), h.env, h.context);
}
async function connect(h, id = extensionA, cookie = browserToken) {
  const pair = await start(h, id); assert.equal((await approve(h, pair.pairId, cookie)).status, 200);
  const result = await handleFormulaExtension(post('pair/token', {pairId: pair.pairId, verifier}, id), h.env, h.context);
  assert.equal(result.status, 200); return result.json();
}
const bearerRequest = (accessToken, id = extensionA, path = 'papers') => post(path, {}, id, {authorization: 'Bearer ' + accessToken});

test('feature is off by default and cannot touch storage or AI', async () => {
  let calls = 0;
  const env = {get DB() {throw Error('Storage must not be touched');}};
  const result = await handleFormulaExtension(post('pair/start', {}), env, {}, {handleAI: async () => {calls++;}});
  assert.equal(result.status, 404); assert.equal(calls, 0);
  assert.equal(await handleFormulaExtension(new Request(origin + '/api/session'), env), null);
});

test('pair start requires the exact requesting extension origin and body identity', async t => {
  const h = setup(t), challenge = await formulaCodeChallenge(verifier);
  for (const badOrigin of ['', origin, 'https://attacker.example', 'null', extensionOrigin(extensionA) + '/', 'chrome-extension://' + 'z'.repeat(32)]) {
    const result = await handleFormulaExtension(post('pair/start', {extensionId: extensionA, challenge}, extensionA, {origin: badOrigin}), h.env, h.context);
    assert.equal(result.status, 403); assert.equal(result.headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await handleFormulaExtension(post('pair/start', {extensionId: extensionB, challenge}), h.env, h.context)).status, 422);
  assert.equal(h.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM formula_pairings').get().n, 0);
});

test('preflight allows only exact extension origins, POST and reviewed noncredentialed headers', async t => {
  const h = setup(t);
  const options = (headers = {}) => request('papers', {method: 'OPTIONS', headers: {origin: extensionOrigin(extensionA),
    'access-control-request-method': 'POST', 'access-control-request-headers': 'Authorization, Content-Type', ...headers}});
  const result = await handleFormulaExtension(options(), h.env, h.context);
  assert.equal(result.status, 204);
  assert.equal(result.headers.get('access-control-allow-origin'), extensionOrigin(extensionA));
  assert.equal(result.headers.get('access-control-allow-credentials'), null);
  assert.equal(result.headers.get('vary'), 'Origin');
  for (const headers of [{'access-control-request-method': 'DELETE'}, {'access-control-request-headers': 'Cookie'}, {origin: 'https://attacker.example'}]) {
    assert.equal((await handleFormulaExtension(options(headers), h.env, h.context)).status, 403);
  }
});

test('pairing GET never approves; approval requires ORCID session, same origin and explicit POST', async t => {
  const h = setup(t), pair = await start(h);
  assert.equal(pair.authorizeUrl, origin + '/extension-connect#pairId=' + pair.pairId);
  assert.equal(pair.expiresAt, (Math.floor(h.clock() / 1000) + 600) * 1000);
  const info = request('pair/info?pairId=' + pair.pairId, {headers: {'sec-fetch-site': 'same-origin'}});
  const shown = await handleFormulaExtension(info, h.env, h.context);
  assert.equal(shown.status, 200); assert.equal((await shown.json()).authenticated, false);
  assert.equal(h.env.DB.sqlite.prepare('SELECT owner FROM formula_pairings').get().owner, null);
  assert.equal((await approve(h, pair.pairId)).status, 401);
  await signIn(h);
  for (const headers of [{origin: 'https://attacker.example'}, {'sec-fetch-site': 'cross-site'}, {origin: extensionOrigin(extensionA)}]) {
    assert.equal((await handleFormulaExtension(websitePost('pair/approve', {pairId: pair.pairId}, browserToken, headers), h.env, h.context)).status, 403);
  }
  assert.equal((await handleFormulaExtension(websitePost('pair/approve', {pairId: pair.pairId, owner: 'forged-owner'}), h.env, h.context)).status, 422);
  assert.equal((await approve(h, pair.pairId)).status, 200);
  assert.equal(h.env.DB.sqlite.prepare('SELECT owner FROM formula_pairings').get().owner, owner);
  assert.equal(h.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM edge_quota_reservations').get().n, 0);
});

test('pending polling requires PKCE proof and does not issue a token before approval', async t => {
  const h = setup(t), pair = await start(h);
  assert.equal((await handleFormulaExtension(post('pair/token', {pairId: pair.pairId, verifier: 'synthetic-wrong-verifier-'.padEnd(64, 'w')}), h.env, h.context)).status, 400);
  assert.equal((await handleFormulaExtension(post('pair/token', {pairId: pair.pairId, verifier}, extensionB), h.env, h.context)).status, 400);
  const pending = await handleFormulaExtension(post('pair/token', {pairId: pair.pairId, verifier}), h.env, h.context);
  assert.equal(pending.status, 202); assert.deepEqual(await pending.json(), {status: 'pending'});
  assert.equal(h.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM formula_extension_tokens').get().n, 0);
});

test('approved pairing is consumed once under concurrent polling and stores only token hashes', async t => {
  const h = setup(t); await signIn(h); const pair = await start(h); await approve(h, pair.pairId);
  const responses = await Promise.all(Array.from({length: 8}, () =>
    handleFormulaExtension(post('pair/token', {pairId: pair.pairId, verifier}), h.env, h.context)));
  assert.equal(responses.filter(result => result.status === 200).length, 1);
  assert.ok(responses.filter(result => result.status !== 200).every(result => result.status === 400));
  const tokenResponse = responses.find(result => result.status === 200), issued = await tokenResponse.json();
  assert.equal(issued.expiresAt, (Math.floor(h.clock() / 1000) + 1200) * 1000);
  assert.equal(tokenResponse.headers.get('set-cookie'), null);
  const persisted = h.env.DB.sqlite.prepare('SELECT * FROM formula_extension_tokens').get();
  assert.equal(persisted.token_hash, await hashToken(issued.accessToken));
  assert.equal(persisted.scope, 'formula:analyze'); assert.equal(persisted.extension_id, extensionA);
  assert.equal(persisted.parent_session_hash, await hashToken(browserToken));
  assert.equal(JSON.stringify(persisted).includes(issued.accessToken), false);
  assert.equal(JSON.stringify(persisted).includes(browserToken), false);
  assert.equal(h.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM formula_pairings').get().n, 0);
});

test('expired pairs cannot be approved or exchanged and pending rows are atomically bounded', async t => {
  const h = setup(t); await signIn(h);
  const attempts = await Promise.all(Array.from({length: 8}, async () => handleFormulaExtension(
    post('pair/start', {extensionId: extensionA, challenge: await formulaCodeChallenge(verifier)}), h.env, h.context)));
  assert.equal(attempts.filter(response => response.status === 200).length, 4);
  assert.ok(attempts.filter(response => response.status !== 200).every(response => response.status === 429));
  const pair = await attempts.find(response => response.status === 200).json();
  h.advance(601000);
  assert.equal((await approve(h, pair.pairId)).status, 410);
  assert.equal((await handleFormulaExtension(post('pair/token', {pairId: pair.pairId, verifier}), h.env, h.context)).status, 400);
  await start(h);
  assert.equal(h.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM formula_pairings').get().n, 1);
});

test('changing extension IDs cannot exceed the global pending-pair capacity', async t => {
  const h = setup(t), seconds = Math.floor(h.clock() / 1000);
  const insert = h.env.DB.sqlite.prepare('INSERT INTO formula_pairings(pair_id,extension_id,challenge,expires,created_at) VALUES(?,?,?,?,?)');
  for (let index = 0; index < 256; index++) {
    const suffix = index.toString(16).split('').map(char => String.fromCharCode(97 + parseInt(char, 16))).join('');
    insert.run(('synthetic-pair-' + index).padEnd(43, 'p'), 'b' + suffix.padStart(31, 'a'), 'synthetic-challenge-'.padEnd(43, 'c'), seconds + 600, seconds);
  }
  const response = await handleFormulaExtension(post('pair/start', {extensionId: extensionA, challenge: await formulaCodeChallenge(verifier)}), h.env, h.context);
  assert.equal(response.status, 429);
  assert.equal(h.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM formula_pairings').get().n, 256);
});

test('active scoped tokens are capped per account across different extension IDs', async t => {
  const h = setup(t); await signIn(h);
  for (let count = 0; count < 8; count++) await connect(h, count % 2 ? extensionA : extensionB);
  const pair = await start(h); await approve(h, pair.pairId);
  const response = await handleFormulaExtension(post('pair/token', {pairId: pair.pairId, verifier}), h.env, h.context);
  assert.equal(response.status, 429);
  assert.equal(h.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM formula_extension_tokens').get().n, 8);
});

test('bearer route binds owner and extension and accepts neither website cookies nor mismatched origins', async t => {
  const h = setup(t); await signIn(h); const issued = await connect(h);
  const identities = [], handler = async (_request, _env, _context, identity) => {identities.push(identity); return Response.json({ok: true});};
  const result = await handleFormulaExtension(bearerRequest(issued.accessToken), h.env, h.context, {handleAI: handler});
  assert.equal(result.status, 200); assert.deepEqual(identities, [{owner, extensionId: extensionA}]);
  assert.equal(result.headers.get('access-control-allow-origin'), extensionOrigin(extensionA));
  for (const req of [bearerRequest(issued.accessToken, extensionB), post('papers', {}, extensionA, {cookie: 'easy_arxiv_session=' + browserToken}),
    post('papers', {}, extensionA, {authorization: 'Bearer invalid'}), post('papers', {}, extensionA, {origin, authorization: 'Bearer ' + issued.accessToken})]) {
    assert.ok([401, 403].includes((await handleFormulaExtension(req, h.env, h.context, {handleAI: handler})).status));
  }
  assert.equal(identities.length, 1);
  h.advance(1201000);
  assert.equal((await handleFormulaExtension(bearerRequest(issued.accessToken), h.env, h.context, {handleAI: handler})).status, 401);
  assert.equal(identities.length, 1);
});

test('revoke invalidates only that scoped connection', async t => {
  const h = setup(t); await signIn(h);
  const first = await connect(h), second = await connect(h, extensionB);
  assert.equal((await handleFormulaExtension(bearerRequest(first.accessToken, extensionA, 'revoke'), h.env, h.context)).status, 200);
  const handler = async () => Response.json({ok: true});
  assert.equal((await handleFormulaExtension(bearerRequest(first.accessToken), h.env, h.context, {handleAI: handler})).status, 401);
  assert.equal((await handleFormulaExtension(bearerRequest(second.accessToken, extensionB), h.env, h.context, {handleAI: handler})).status, 200);
});

test('website logout immediately revokes issued tokens and pending approvals only for that parent session', async t => {
  const h = setup(t); await signIn(h);
  const first = await connect(h), pending = await start(h); await approve(h, pending.pairId);
  const secondBrowser = 'synthetic-other-browser-session-'.padEnd(43, 'y');
  await signIn(h, owner, secondBrowser);
  const other = await connect(h, extensionB, secondBrowser);
  let calls = 0;
  const handler = async () => {calls++; return Response.json({ok: true});};
  const logout = await handleAuth(new Request(origin + '/auth/logout', {method: 'POST',
    headers: {origin, cookie: 'easy_arxiv_session=' + browserToken}}), h.env, h.context);
  assert.equal(logout.status, 200);
  assert.equal((await handleFormulaExtension(bearerRequest(first.accessToken), h.env, h.context, {handleAI: handler})).status, 401);
  assert.equal((await handleFormulaExtension(post('pair/token', {pairId: pending.pairId, verifier}), h.env, h.context)).status, 400);
  assert.equal((await handleFormulaExtension(bearerRequest(other.accessToken, extensionB), h.env, h.context, {handleAI: handler})).status, 200);
  assert.equal(calls, 1);
  assert.equal(h.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM formula_extension_tokens WHERE parent_session_hash=?').get(await hashToken(browserToken)).n, 0);
  assert.equal(h.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM formula_pairings WHERE parent_session_hash=?').get(await hashToken(browserToken)).n, 0);
});

test('parent expiry is checked from stored hashes even before expired rows are cleaned', async t => {
  const h = setup(t); await signIn(h); const issued = await connect(h);
  h.env.DB.sqlite.prepare('UPDATE edge_sessions SET expires=? WHERE token_hash=?')
    .run(Math.floor(h.clock() / 1000) - 1, await hashToken(browserToken));
  assert.equal(h.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM formula_extension_tokens').get().n, 1);
  let calls = 0;
  const result = await handleFormulaExtension(bearerRequest(issued.accessToken), h.env, h.context,
    {handleAI: async () => {calls++; return Response.json({ok: true});}});
  assert.equal(result.status, 401); assert.equal(calls, 0);
});

test('scoped token expiry never exceeds its approving website session', async t => {
  const h = setup(t), expires = Math.floor(h.clock() / 1000) + 30;
  await h.context.store.createSession(await hashToken(browserToken), {orcid: owner, name: 'Synthetic Reader'}, expires);
  const issued = await connect(h);
  assert.equal(issued.expiresAt, expires * 1000);
});

test('unknown backend failures return a fixed error with scoped CORS, not provider details', async t => {
  const h = setup(t); await signIn(h); const issued = await connect(h);
  const result = await handleFormulaExtension(bearerRequest(issued.accessToken), h.env, h.context,
    {handleAI: async () => {throw Error('synthetic-private-provider-detail');}});
  assert.equal(result.status, 503); assert.equal(result.headers.get('access-control-allow-origin'), extensionOrigin(extensionA));
  assert.equal((await result.text()).includes('synthetic-private-provider-detail'), false);
});

test('new bearer tokens cannot access existing saved-paper or Quest cookie APIs', async t => {
  const h = setup(t); await signIn(h); const issued = await connect(h);
  for (const path of ['/api/saved', '/api/getPaperData?pdf=https%3A%2F%2Farxiv.org%2Fpdf%2F1706.03762']) {
    const result = await handleRequest(new Request(origin + path, {headers: {origin: extensionOrigin(extensionA), authorization: 'Bearer ' + issued.accessToken}}), h.env, h.context);
    assert.equal(result.status, 401); assert.equal(result.headers.get('access-control-allow-origin'), null);
  }
  const result = await handleRequest(new Request(origin + '/api/getPaperData?pdf=https%3A%2F%2Farxiv.org%2Fpdf%2F1706.03762',
    {headers: {origin: extensionOrigin(extensionA), cookie: 'easy_arxiv_session=' + browserToken}}), h.env, h.context);
  assert.equal(result.status, 403); assert.equal(result.headers.get('access-control-allow-origin'), null);
});

test('connection bodies are bounded and an extension origin never grants website approval', async t => {
  const h = setup(t);
  assert.equal((await handleFormulaExtension(post('pair/start', {extensionId: extensionA, challenge: 'x'.repeat(5000)}), h.env, h.context)).status, 413);
  assert.equal((await handleFormulaExtension(request('pair/start', {method: 'POST', headers: {origin: extensionOrigin(extensionA), 'content-type': 'text/plain'}, body: '{}'}), h.env, h.context)).status, 415);
  assert.equal((await handleFormulaExtension(post('pair/approve', {pairId: 'a'.repeat(43)}), h.env, h.context)).status, 403);
});

test('approval page refresh and focus never grant access; only the explicit Connect button posts approval', async () => {
  const callbacks = {}, nodes = new Map(), calls = [];
  for (const id of ['connectionStatus', 'approveConnection', 'signIn', 'signInHelp', 'extensionId', 'accountLabel', 'refreshSession', 'cancelConnection']) {
    nodes.set(id, {hidden: true, disabled: false, textContent: '', addEventListener: (_, callback) => {callbacks[id] = callback;}});
  }
  const pair = 'synthetic-pair-id-'.padEnd(43, 'p');
  const script = readFileSync(new URL('../static/js/extension-connect.js', import.meta.url), 'utf8');
  const sandbox = {document: {getElementById: id => nodes.get(id)}, location: {hash: '#pairId=' + pair}, URLSearchParams,
    window: {addEventListener: (_, callback) => {callbacks.focus = callback;}}, fetch: async (url, options) => {
      calls.push({url, options});
      return Response.json(options.method === 'POST' ? {approved: true} :
        {pairId: pair, extensionId: extensionA, authenticated: true, approved: false, user: {name: 'Synthetic Reader'}});
    }};
  vm.runInNewContext(script, sandbox);
  for (let index = 0; index < 20; index++) await Promise.resolve();
  callbacks.focus(); callbacks.refreshSession();
  for (let index = 0; index < 20; index++) await Promise.resolve();
  assert.equal(calls.some(call => call.options.method === 'POST'), false);
  await callbacks.approveConnection();
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(calls.at(-1).url, '/api/extension/pair/approve');
  assert.equal(calls.at(-1).options.credentials, 'same-origin');
  assert.equal(nodes.get('approveConnection').disabled, true);
  assert.equal(nodes.get('cancelConnection').textContent, 'Return to Easy ArXiv');
  const count = calls.length; callbacks.focus();
  for (let index = 0; index < 20; index++) await Promise.resolve();
  assert.equal(calls.length, count);
});
