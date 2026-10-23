import assert from 'node:assert/strict';
import test from 'node:test';
import worker, {backendOrigin, isBackendRequest, proxy} from '../cloudflare/pages-worker.mjs';

const PUBLIC = 'https://easy-arxiv.pages.dev';
const BACKEND = 'https://easy-arxiv-123456789012.europe-west1.run.app';
const env = {BACKEND_ORIGIN: BACKEND};

test('only configured Cloud Run HTTPS origins are accepted', () => {
  for (const value of [BACKEND, BACKEND + '/', 'https://easy-arxiv-abcdef-uc.a.run.app']) {
    assert.equal(backendOrigin(value), new URL(value).origin);
  }
  for (const value of [undefined, '', ' ' + BACKEND, BACKEND + ' ', 'http://service.run.app',
    'https://service.run.app.evil.example', 'https://evil-run.app', 'https://user:pass@service.run.app',
    'https://service.run.app:444', 'https://service.run.app:443', 'https://service.run.app\\',
    'https://service.run.app/api', 'https://service.run.app/?secret=test',
    'https://service.run.app/#test', 'https://127.0.0.1', 'file:///tmp/service.run.app']) {
    assert.equal(backendOrigin(value), null, `must reject ${value}`);
  }
});

test('only API, auth, and legacy root OAuth parameters are proxied', () => {
  for (const path of ['/api', '/api/search?q=test', '/auth', '/auth/login', '/auth/callback?code=x&state=y',
    '/?code=x&state=y', '/?error=access_denied', '/?state=y']) {
    assert.equal(isBackendRequest(new URL(path, PUBLIC)), true, path);
  }
  for (const path of ['/', '/?q=attention', '/?auth=success', '/papers', '/read?paper=x', '/saved', '/quest',
    '/ai_quest', '/static/js/core.js', '/apiary', '/authentication']) {
    assert.equal(isBackendRequest(new URL(path, PUBLIC)), false, path);
  }
});

test('static home and pages are served without any configured backend', async () => {
  for (const path of ['/', '/papers?q=test', '/read?paper=1706.03762', '/saved', '/quest', '/ai_quest', '/static/brand.svg']) {
    const calls = [];
    const response = await worker.fetch(new Request(PUBLIC + path), {
      ASSETS: {fetch: async request => { calls.push(request.url); return new Response('<h1>Existing design</h1>'); }},
    });
    assert.equal(await response.text(), '<h1>Existing design</h1>');
    assert.deepEqual(calls, [PUBLIC + path]);
  }
});

test('proxy preserves method, query, body, credentials and real browser origin', async () => {
  const request = new Request(PUBLIC + '/api/saved?value=%26encoded%3Dyes', {
    method: 'POST', body: JSON.stringify({id: '1706.03762'}),
    headers: {'content-type': 'application/json', cookie: 'easy_arxiv_session=test-only-session',
      origin: PUBLIC, 'sec-fetch-site': 'same-origin', 'x-forwarded-host': 'evil.example',
      forwarded: 'host=evil.example;proto=http', 'x-forwarded-proto': 'http',
      'x-real-ip': '123.123.123.123', 'x-easy-arxiv-public-origin': 'https://evil.example'},
  });
  let calls = 0;
  const result = await proxy(request, env, async (outgoing, options) => {
    calls++;
    assert.equal(outgoing.url, BACKEND + '/api/saved?value=%26encoded%3Dyes');
    assert.equal(outgoing.method, 'POST');
    assert.equal(await outgoing.text(), JSON.stringify({id: '1706.03762'}));
    assert.equal(outgoing.headers.get('cookie'), 'easy_arxiv_session=test-only-session');
    assert.equal(outgoing.headers.get('origin'), PUBLIC);
    assert.equal(outgoing.headers.get('sec-fetch-site'), 'same-origin');
    assert.equal(outgoing.headers.get('x-easy-arxiv-public-origin'), PUBLIC);
    for (const name of ['x-forwarded-host', 'forwarded', 'x-forwarded-proto', 'x-real-ip', 'host']) {
      assert.equal(outgoing.headers.has(name), false, name);
    }
    assert.equal(outgoing.redirect, 'manual');
    assert.equal(options.cache, 'no-store');
    return new Response('{"saved":true}', {headers: {'content-type': 'application/json'}});
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 200);
  assert.equal(await result.text(), '{"saved":true}');
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
});

test('proxy never fabricates a same-origin Origin for cross-site or missing headers', async () => {
  for (const origin of ['https://evil.example', null]) {
    const response = await proxy(new Request(PUBLIC + '/auth/logout', {
      method: 'POST', headers: origin ? {origin, 'sec-fetch-site': 'cross-site'} : {},
    }), env, async outgoing => {
      assert.equal(outgoing.headers.get('origin'), origin);
      assert.equal(outgoing.headers.get('sec-fetch-site'), origin ? 'cross-site' : null);
      return new Response('Forbidden', {status: 403});
    });
    assert.equal(response.status, 403);
  }
});

test('OAuth redirects preserve multiple independent Set-Cookie headers and rewrite backend locations', async () => {
  const headers = new Headers({location: BACKEND + '/?auth=success', 'cache-control': 'public,max-age=300',
    etag: 'stale', 'last-modified': 'yesterday', age: '200'});
  headers.append('set-cookie', 'easy_arxiv_session=test-session; Path=/; Secure; HttpOnly; SameSite=Lax');
  headers.append('set-cookie', 'easy_arxiv_oauth_state=""; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax');
  const response = await proxy(new Request(PUBLIC + '/auth/callback?code=test-code&state=test-state'), env,
    async outgoing => {
      assert.equal(outgoing.url, BACKEND + '/auth/callback?code=test-code&state=test-state');
      return new Response(null, {status: 302, headers});
    });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), PUBLIC + '/?auth=success');
  assert.deepEqual(response.headers.getSetCookie(), headers.getSetCookie());
  assert.equal(response.headers.get('cloudflare-cdn-cache-control'), 'no-store');
  assert.equal(response.headers.has('etag'), false);
  assert.equal(response.headers.has('last-modified'), false);
  assert.equal(response.headers.has('age'), false);
});

test('external ORCID redirect remains external and backend-relative redirect uses frontend', async () => {
  for (const [location, expected] of [['https://orcid.org/oauth/authorize?state=test', 'https://orcid.org/oauth/authorize?state=test'],
    ['/?auth=success', PUBLIC + '/?auth=success'], ['//easy-arxiv-123456789012.europe-west1.run.app/saved', PUBLIC + '/saved']]) {
    const response = await proxy(new Request(PUBLIC + '/auth/login'), env,
      async () => new Response(null, {status: 302, headers: {location}}));
    assert.equal(response.headers.get('location'), expected);
  }
});

test('HEAD and DELETE are preserved and proxy does not cache error responses', async () => {
  for (const method of ['HEAD', 'DELETE']) {
    const response = await proxy(new Request(PUBLIC + '/api/saved/test', {method}), env, async outgoing => {
      assert.equal(outgoing.method, method);
      return new Response(null, {status: 401});
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
});

test('misconfiguration, upstream failure and exception never return private details', async () => {
  const marker = 'SYNTHETIC_PRIVATE_TEST_MARKER';
  const request = () => new Request(PUBLIC + '/api/search?q=hello');
  const responses = [
    await proxy(request(), {}, () => { throw Error('should not fetch without backend'); }),
    await proxy(request(), {BACKEND_ORIGIN: 'https://evil.example'}, () => { throw Error('should not fetch invalid backend'); }),
    await proxy(request(), env, async () => new Response(marker, {status: 500})),
    await proxy(request(), env, async () => { throw Error(marker); }),
  ];
  for (const response of responses) {
    assert.equal(response.status, 503);
    const content = await response.text();
    assert.equal(content.includes(marker), false);
    assert.equal(content.includes(BACKEND), false);
    assert.match(content, /temporarily unavailable/);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
});
