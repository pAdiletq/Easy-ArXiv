import test from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteD1 } from './helpers/d1.mjs';
import { EdgeStore, EdgeError, handleAuth, sessionUser, requireSameOrigin, hashToken, normalizeSavedPaper } from '../cloudflare/edge-auth.mjs';

const origin = 'https://easy-arxiv.pages.dev';
const ownerA = '0000-0001-2345-6789', ownerB = '0000-0002-2345-6789';
const paper = { id: '1706.03762v7', title: 'Attention Is All You Need', authors: ['A Researcher'],
  published: '2017-06-12T00:00:00Z', summary: 'A paper about attention.', category: 'cs.CL' };
const request = (path, options = {}) => new Request(origin + path, options);
function setup(t) {
  const DB = new SQLiteD1();
  t.after(() => DB.close());
  return { DB, PUBLIC_ORIGIN: origin, ORCID_CLIENT_ID: 'test-client',
    ORCID_CLIENT_SECRET: 'synthetic-test-orcid-secret', ORCID_REDIRECT_URI: origin + '/auth/callback' };
}
const getCookies = response => response.headers.getSetCookie();
const cookieValue = (response, name) => getCookies(response).find(value => value.startsWith(name + '='))?.split(';')[0];
async function identity(env, user, token = 'test-browser-session-'.padEnd(43, 'a'), now = Date.now()) {
  await new EdgeStore(env.DB).createSession(await hashToken(token), { orcid: user, name: 'Test Reader' }, Math.floor(now / 1000) + 600);
  return `easy_arxiv_session=${token}`;
}

test('ORCID state is browser-bound, one-use and survives handler/worker reconstruction', async t => {
  const env = setup(t), clock = Date.now(), now = () => clock;
  const start = await handleAuth(request('/auth/login'), env, { now });
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  assert.match(start.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  assert.equal(new URL(start.headers.get('location')).searchParams.get('redirect_uri'), origin + '/auth/callback');
  assert.ok(!start.headers.get('location').includes('synthetic-test'));
  const storedState = env.DB.sqlite.prepare('SELECT * FROM edge_oauth_states').get();
  assert.equal(storedState.state_hash, await hashToken(state));
  assert.ok(!JSON.stringify(storedState).includes(state));
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, 'https://orcid.org/oauth/token');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.body.get('redirect_uri'), origin + '/auth/callback');
    assert.equal(options.body.get('client_secret'), 'synthetic-test-orcid-secret');
    return Response.json({ orcid: ownerA, name: 'Test Reader', access_token: 'synthetic-test-provider-token' });
  };
  const path = `/auth/callback?code=test-provider-code&state=${state}`;
  const wrongBrowser = await handleAuth(request(path, { headers: { Cookie: 'easy_arxiv_oauth_state=' + 'b'.repeat(43) } }), env, { now, fetchImpl });
  assert.equal(wrongBrowser.status, 400);
  assert.equal(calls, 0);
  const done = await handleAuth(request(path, { headers: { Cookie: cookieValue(start, 'easy_arxiv_oauth_state') } }), { ...env }, { now, fetchImpl });
  assert.equal(done.status, 303);
  assert.equal(done.headers.get('location'), '/?auth=success');
  assert.equal(done.headers.get('referrer-policy'), 'no-referrer');
  const sessionCookie = cookieValue(done, 'easy_arxiv_session');
  assert.match(sessionCookie, /^easy_arxiv_session=[A-Za-z0-9_-]{43}$/);
  const account = await handleAuth(request('/api/session', { headers: { Cookie: sessionCookie } }), { ...env }, { now });
  assert.deepEqual(await account.json(), { authenticated: true, user: { orcid: ownerA, name: 'Test Reader' } });
  const persisted = env.DB.sqlite.prepare('SELECT * FROM edge_sessions').get();
  assert.ok(!JSON.stringify(persisted).includes(sessionCookie.split('=')[1]));
  assert.ok(!JSON.stringify(persisted).includes('synthetic-test-provider-token'));
  const replay = await handleAuth(request(path, { headers: { Cookie: cookieValue(start, 'easy_arxiv_oauth_state') } }), env, { now, fetchImpl });
  assert.equal(replay.status, 400);
  assert.equal(calls, 1);
});

test('failed provider responses are fixed safe errors and consumed state cannot be replayed', async t => {
  const env = setup(t);
  const start = await handleAuth(request('/auth/login'), env);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const callback = request(`/auth/callback?state=${state}&code=test-code`, { headers: { Cookie: cookieValue(start, 'easy_arxiv_oauth_state') } });
  const result = await handleAuth(callback, env, { fetchImpl: async () => { throw new Error('provider-sensitive-response'); } });
  assert.equal(result.status, 502);
  assert.ok(!(await result.text()).includes('provider-sensitive-response'));
  assert.equal(await new EdgeStore(env.DB).consumeState(await hashToken(state), 0), false);
});

test('ORCID rejects every provider 3xx without forwarding OAuth credentials or creating a session', async t => {
  const env = setup(t);
  let calls = 0;
  for (let status = 300; status < 400; status++) {
    const start = await handleAuth(request('/auth/login'), env);
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const callback = request(`/auth/callback?state=${state}&code=test-code`,
      {headers: {Cookie: cookieValue(start, 'easy_arxiv_oauth_state')}});
    const result = await handleAuth(callback, env, {fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://orcid.org/oauth/token');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.body.get('client_secret'), 'synthetic-test-orcid-secret');
      return new Response(status === 304 ? null : 'synthetic-provider-response-detail',
        {status, headers: {location: 'https://untrusted.example/provider-redirect'}});
    }});
    assert.equal(result.status, 502);
    assert.equal(result.headers.get('location'), null);
    assert.equal(result.headers.get('set-cookie'), null);
    assert.ok(!(await result.text()).includes('synthetic-'));
  }
  assert.equal(calls, 100);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM edge_sessions').get().n, 0);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM edge_oauth_states').get().n, 0);
});

test('anonymous sign-in state capacity is bounded atomically and recovers after expiry', async t => {
  const env = setup(t), now = Math.floor(Date.now() / 1000);
  const attempts = await Promise.allSettled(Array.from({ length: 270 }, (_, index) =>
    new EdgeStore(env.DB).createState(`test-state-hash-${index}`, now + 600)));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 256);
  assert.ok(attempts.filter(result => result.status === 'rejected').every(result => result.reason instanceof EdgeError && result.reason.status === 503));
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM edge_oauth_states').get().n, 256);
  await new EdgeStore(env.DB).createState('test-state-after-expiry', now + 1201);
  assert.equal(await new EdgeStore(env.DB).consumeState('test-state-after-expiry', now + 601), true);
});

test('session expiration/revocation and persistence are checked across store instances', async t => {
  const env = setup(t), clock = Date.now();
  const Cookie = await identity(env, ownerA, undefined, clock);
  assert.equal((await sessionUser(request('/api/session', { headers: { Cookie } }), { ...env }, { now: () => clock })).orcid, ownerA);
  assert.equal(await sessionUser(request('/api/session', { headers: { Cookie } }), env, { now: () => clock + 601000 }), null);
  const blocked = await handleAuth(request('/auth/logout', { method: 'POST', headers: { Cookie, Origin: 'https://attacker.test' } }), env);
  assert.equal(blocked.status, 403);
  const logout = await handleAuth(request('/auth/logout', { method: 'POST', headers: { Cookie, Origin: origin } }), env);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(await sessionUser(request('/api/session', { headers: { Cookie } }), { ...env }), null);
});

test('saved papers are account-scoped, canonical and update without duplicate copies', async t => {
  const env = setup(t), Cookie = await identity(env, ownerA);
  const save = value => handleAuth(request('/api/saved', { method: 'POST', headers: { Cookie, Origin: origin }, body: JSON.stringify({ paper: value }) }), env);
  assert.equal((await save(paper)).status, 200);
  let result = await handleAuth(request('/api/saved', { headers: { Cookie } }), env);
  const original = (await result.json()).papers[0];
  assert.equal(original.id, '1706.03762');
  assert.equal(original.pdf_url, 'https://arxiv.org/pdf/1706.03762v7');
  await save({ ...paper, title: 'Updated title' });
  const otherCookie = await identity(env, ownerB, 'test-other-browser-session-'.padEnd(43, 'b'));
  assert.deepEqual(await (await handleAuth(request('/api/saved', { headers: { Cookie: otherCookie } }), env)).json(), { papers: [], has_more: false, next_start: null });
  await handleAuth(request('/api/saved/1706.03762', { method: 'DELETE', headers: { Cookie: otherCookie, Origin: origin } }), env);
  const { papers: items } = await new EdgeStore(env.DB).listSaved(ownerA);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Updated title');
  assert.equal(items[0].saved_at, original.saved_at);
  await handleAuth(request('/api/saved/1706.03762v9', { method: 'DELETE', headers: { Cookie, Origin: origin } }), env);
  assert.deepEqual((await new EdgeStore(env.DB).listSaved(ownerA)).papers, []);
});

test('cross-origin mutations and forged forwarding headers cannot bypass configured origin', async t => {
  const env = setup(t), Cookie = await identity(env, ownerA);
  for (const headers of [
    {}, { Origin: 'https://attacker.test', 'X-Forwarded-Host': 'attacker.test', 'X-Easy-Arxiv-Public-Origin': 'https://attacker.test' },
    { Origin: origin, 'Sec-Fetch-Site': 'cross-site' }, { Origin: origin + '/' },
  ]) {
    const response = await handleAuth(request('/api/saved', { method: 'POST', headers: { Cookie, ...headers }, body: JSON.stringify({ paper }) }), env);
    assert.equal(response.status, 403);
  }
  assert.throws(() => requireSameOrigin(new Request('https://preview.pages.dev/api/saved', { method: 'POST', headers: { Origin: 'https://preview.pages.dev' } }), env), error => error.status === 403);
  assert.doesNotThrow(() => requireSameOrigin(request('/api/getPaperData', { headers: { 'Sec-Fetch-Site': 'same-origin' } }), env, { sameOriginGet: true }));
  assert.deepEqual((await new EdgeStore(env.DB).listSaved(ownerA)).papers, []);
});

test('quotas atomically reserve both counters and failed reservations consume neither', async t => {
  const env = setup(t), day = new Date().toISOString().slice(0, 10);
  const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    new EdgeStore(env.DB).reserveAI(index % 2 ? ownerA : ownerB, day, 2, 3)));
  assert.equal(attempts.filter(Boolean).length, 3);
  assert.equal(env.DB.sqlite.prepare('SELECT count FROM edge_quota_totals WHERE day=?').get(day).count, 3);
  const accounts = env.DB.sqlite.prepare('SELECT count FROM edge_quota_users WHERE day=?').all(day);
  assert.equal(accounts.reduce((sum, row) => sum + row.count, 0), 3);
  assert.ok(accounts.every(row => row.count <= 2));
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM edge_quota_reservations').get().n, 3);
  assert.equal(await new EdgeStore(env.DB).reserveAI(ownerA, day, 2, 3), false);
});

test('arXiv scheduling serializes isolates and a full queue does not reserve hours ahead', async t => {
  const env = setup(t), now = Date.now();
  const waits = await Promise.all(Array.from({ length: 6 }, () => new EdgeStore(env.DB).acquireArxivSlot(now)));
  assert.deepEqual(waits.sort((left, right) => left - right), [0, 3000, 6000, 9000, 12000, 15000]);
  await assert.rejects(new EdgeStore(env.DB).acquireArxivSlot(now), error => error instanceof EdgeError && error.status === 503);
  assert.equal(env.DB.sqlite.prepare('SELECT next_ms FROM edge_arxiv_schedule').get().next_ms, now + 18000);
  assert.equal(await new EdgeStore(env.DB).acquireArxivSlot(now + 18000), 0);
});

test('research traffic cleans expired data without removing saved papers or current sessions', async t => {
  const env = setup(t), now = Date.now(), seconds = Math.floor(now / 1000), store = new EdgeStore(env.DB);
  await store.createSession('test-old-hash', { orcid: ownerA }, seconds - 1);
  await store.createSession('test-current-hash', { orcid: ownerB }, seconds + 60);
  await store.savePaper(ownerA, normalizeSavedPaper(paper));
  env.DB.sqlite.prepare('INSERT INTO edge_cache(key,payload,expires) VALUES(?,?,?)').run('old', '{}', now - 1);
  env.DB.sqlite.prepare('INSERT INTO edge_oauth_states(state_hash,expires) VALUES(?,?)').run('test-expired-state-hash', seconds - 1);
  await store.acquireArxivSlot(now);
  assert.equal(await store.getSession('test-old-hash', seconds - 2), null);
  assert.equal((await store.getSession('test-current-hash', seconds)).orcid, ownerB);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM edge_cache').get().n, 0);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM edge_oauth_states').get().n, 0);
  assert.equal((await store.listSaved(ownerA)).papers.length, 1);
});

test('missing DB, partial OAuth configuration and malformed metadata fail safely', async t => {
  const env = setup(t);
  let response = await handleAuth(request('/api/session'), { PUBLIC_ORIGIN: origin });
  assert.equal(response.status, 503);
  response = await handleAuth(request('/auth/login'), { ...env, ORCID_CLIENT_SECRET: '' });
  assert.equal(response.status, 503);
  const Cookie = await identity(env, ownerA);
  for (const value of [{ ...paper, pdf_url: 'https://127.0.0.1/private.pdf' }, { ...paper, authors: 'wrong type' }, { ...paper, summary: 'x'.repeat(40001) }]) {
    response = await handleAuth(request('/api/saved', { method: 'POST', headers: { Cookie, Origin: origin }, body: JSON.stringify({ paper: value }) }), env);
    assert.equal(response.status, 422);
  }
  response = await handleAuth(request('/api/saved', { method: 'POST', headers: { Cookie, Origin: origin }, body: 'x'.repeat(64 * 1024 + 1) }), env);
  assert.equal(response.status, 413);
  assert.equal(await handleAuth(request('/papers'), env), null);
});

test('saved capacity is atomic across stores, permits updates and is isolated by account', async t => {
  const env = setup(t);
  const papers = Array.from({ length: 120 }, (_, index) => normalizeSavedPaper({ ...paper, id: `2000.${String(index).padStart(5, '0')}` }));
  const attempts = await Promise.allSettled(papers.map(value => new EdgeStore(env.DB).savePaper(ownerA, value)));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 100);
  assert.equal(attempts.filter(result => result.status === 'rejected').length, 20);
  assert.ok(attempts.filter(result => result.status === 'rejected').every(result => result.reason instanceof EdgeError && result.reason.status === 409));
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM edge_saved WHERE owner=?').get(ownerA).n, 100);
  await new EdgeStore(env.DB).savePaper(ownerA, { ...papers[0], title: 'An update at capacity' });
  assert.equal(JSON.parse(env.DB.sqlite.prepare('SELECT metadata FROM edge_saved WHERE owner=? AND paper_id=?').get(ownerA, papers[0].id).metadata).title, 'An update at capacity');
  await new EdgeStore(env.DB).savePaper(ownerB, papers[100]);
  assert.equal((await new EdgeStore(env.DB).listSaved(ownerB)).papers.length, 1);
  await new EdgeStore(env.DB).deleteSaved(ownerA, papers[0].id);
  await new EdgeStore(env.DB).savePaper(ownerA, papers[100]);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM edge_saved WHERE owner=?').get(ownerA).n, 100);
});

test('saved pagination returns at most twenty indexed records and bounded offsets', async t => {
  const env = setup(t), Cookie = await identity(env, ownerA);
  for (let index = 0; index < 45; index++) {
    await new EdgeStore(env.DB).savePaper(ownerA, normalizeSavedPaper({ ...paper, id: `2100.${String(index).padStart(5, '0')}` }));
  }
  const ids = [];
  for (const [start, count, more, next] of [[0, 20, true, 20], [20, 20, true, 40], [40, 5, false, null]]) {
    const response = await handleAuth(request(`/api/saved?start=${start}`, { headers: { Cookie } }), env);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.papers.length, count);
    assert.equal(result.has_more, more);
    assert.equal(result.next_start, next);
    ids.push(...result.papers.map(value => value.id));
  }
  assert.equal(new Set(ids).size, 45);
  for (const start of ['-1', '101', '1.5', 'Infinity', '1e2', '0 UNION SELECT 1']) {
    const response = await handleAuth(request('/api/saved?start=' + encodeURIComponent(start), { headers: { Cookie } }), env);
    assert.equal(response.status, 422);
  }
  const plan = env.DB.sqlite.prepare('EXPLAIN QUERY PLAN SELECT metadata,saved_at FROM edge_saved WHERE owner=? ORDER BY saved_at DESC,paper_id LIMIT 21 OFFSET ?').all(ownerA, 0);
  assert.ok(plan.some(value => value.detail.includes('edge_saved_owner_date')));
  assert.ok(plan.every(value => !value.detail.includes('TEMP B-TREE')));
});

test('saved metadata is bounded before persistence and labels abstract excerpts honestly', async t => {
  const env = setup(t), Cookie = await identity(env, ownerA);
  const save = value => handleAuth(request('/api/saved', { method: 'POST', headers: { Cookie, Origin: origin }, body: JSON.stringify({ paper: value }) }), env);
  const original = { ...paper, summary: 'a'.repeat(40000), authors: Array.from({ length: 25 }, () => 'A'.repeat(300)) };
  const result = await save(original);
  assert.equal(result.status, 200);
  const stored = (await new EdgeStore(env.DB).listSaved(ownerA)).papers[0];
  assert.equal(stored.summary.length, 4000);
  assert.equal(stored.summary_label, 'Abstract excerpt');
  assert.equal(stored.authors.length, 20);
  assert.ok(stored.authors.every(name => name.length === 200));
  const oversized = await save({ ...paper, id: '2300.00001', summary: '漢'.repeat(4000), authors: Array.from({ length: 20 }, () => '漢'.repeat(200)) });
  assert.equal(oversized.status, 413);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM edge_saved').get().n, 1);
});
