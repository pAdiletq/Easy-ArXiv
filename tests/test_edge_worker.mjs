import assert from 'node:assert/strict';
import test from 'node:test';
import {SQLiteD1} from './helpers/d1.mjs';
import {EdgeStore, hashToken} from '../cloudflare/edge-auth.mjs';
import {handleRequest} from '../cloudflare/edge-worker.mjs';
import {generateStudy, normalizeStudy} from '../cloudflare/edge-ai.mjs';

const origin = 'https://easy-arxiv.pages.dev', pdf = 'https://arxiv.org/pdf/1706.03762';
const user = {orcid: '0000-0001-2345-6789', name: 'Reader'};
const token = 'test-only-browser-session-'.padEnd(43, 'a');
const req = (path, options) => new Request(origin + path, options);
const study = () => ({flashcards: Array.from({length: 9}, (_, index) => ({topic: `Idea ${index + 1}`, content: 'An explanation grounded in the supplied paper.'})),
  questions: Array.from({length: 9}, (_, index) => ({question: `Question ${index + 1}?`,
    options: ['Option one', 'Option two', 'Option three', 'Option four'], answer: index % 4, explanation: 'An explanation from the paper.'}))});
function setup(t) {
  const DB = new SQLiteD1();
  t.after(() => DB.close());
  return {DB, PUBLIC_ORIGIN: origin, GOOGLE_API_KEY: 'synthetic-test-gemini-value',
    ASSETS: {fetch: async request => new Response('Existing page: ' + new URL(request.url).pathname)}};
}
async function signIn(env) {
  await new EdgeStore(env.DB).createSession(await hashToken(token), user, Math.floor(Date.now() / 1000) + 600);
  return {cookie: `easy_arxiv_session=${token}`, 'sec-fetch-site': 'same-origin'};
}

test('static pages keep working without database, origin or provider credentials', async () => {
  let calls = 0;
  const env = {ASSETS: {fetch: async () => { calls++; return new Response('Accepted design'); }}};
  for (const path of ['/', '/papers', '/read?paper=1706.03762', '/quest?demo=attention', '/static/brand.svg']) {
    const response = await handleRequest(req(path), env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'Accepted design');
  }
  assert.equal(calls, 5);
});

test('production account APIs reject preview hosts and forged forwarding headers', async t => {
  const env = setup(t);
  const response = await handleRequest(new Request('https://preview.easy-arxiv.pages.dev/api/session', {
    headers: {'x-forwarded-host': 'easy-arxiv.pages.dev', 'x-forwarded-proto': 'https', origin},
  }), env);
  assert.equal(response.status, 403);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal((await handleRequest(req('/api/session'), {PUBLIC_ORIGIN: origin})).status, 503);
});

test('public configuration exposes capability flags, never provider secrets', async t => {
  const env = {...setup(t), ORCID_CLIENT_ID: 'test-client', ORCID_CLIENT_SECRET: 'synthetic-test-orcid-value', ORCID_REDIRECT_URI: origin + '/auth/callback'};
  const response = await handleRequest(req('/api/config'), env);
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!text.includes('synthetic-test'));
  assert.equal(JSON.parse(text).orcid_configured, true);
  assert.equal(JSON.parse(text).ai_quest_requires_login, true);
});

test('AI generation uses only a canonical public PDF and keeps credentials in provider headers', async () => {
  let calls = 0;
  const env = {GOOGLE_API_KEY: 'synthetic-test-gemini-value'};
  const result = await generateStudy(pdf, env, async (url, options) => {
    calls++;
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    assert.ok(!url.includes('synthetic-test'));
    assert.equal(options.headers['x-goog-api-key'], env.GOOGLE_API_KEY);
    assert.equal(options.redirect, 'manual');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.contents[0].parts[0], {fileData: {mimeType: 'application/pdf', fileUri: pdf}});
    assert.ok(body.systemInstruction.parts[0].text.includes('untrusted'));
    return Response.json({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify(study())}]}}]});
  });
  assert.equal(calls, 1);
  assert.equal(result.flashcards.flashcards.length, 9);
  assert.equal(Object.keys(result.questions.questions).length, 9);
  assert.ok(!JSON.stringify(result).includes('synthetic-test'));
});

test('AI requires an account and real same-origin request, even before cache lookup', async t => {
  const env = setup(t);
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('should never be called'); };
  assert.equal((await handleRequest(req('/api/getPaperData?pdf=' + encodeURIComponent(pdf)), env, {fetchImpl})).status, 401);
  const headers = await signIn(env);
  const crossOrigin = await handleRequest(req('/api/getPaperData?pdf=' + encodeURIComponent(pdf), {
    headers: {...headers, origin: 'https://untrusted.example', 'sec-fetch-site': 'cross-site'},
  }), env, {fetchImpl});
  assert.equal(crossOrigin.status, 403);
  assert.equal(calls, 0);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM edge_quota_reservations').get().n, 0);
});

test('AI rejects every provider 3xx without forwarding the API header or response details', async () => {
  let calls = 0;
  for (let status = 300; status < 400; status++) {
    const env = {GOOGLE_API_KEY: 'synthetic-test-gemini-value'};
    const destination = 'https://untrusted.example/provider-redirect';
    await assert.rejects(generateStudy(pdf, env, async (url, options) => {
      calls++;
      assert.equal(new URL(url).origin, 'https://generativelanguage.googleapis.com');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers['x-goog-api-key'], env.GOOGLE_API_KEY);
      return new Response(status === 304 ? null : 'synthetic-provider-response-detail',
        {status, headers: {location: destination}});
    }), error => {
      assert.equal(error.status, 502);
      assert.ok(!error.message.includes('synthetic-'));
      assert.ok(!error.message.includes(destination));
      return true;
    });
  }
  assert.equal(calls, 100);
});

test('AI cache persists across handler reconstruction and daily quota blocks extra provider requests', async t => {
  const env = {...setup(t), AI_USER_DAILY_LIMIT: '1', AI_GLOBAL_DAILY_LIMIT: '2'};
  const headers = await signIn(env);
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return Response.json({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify(study())}]}}]});
  };
  const path = '/api/getPaperData?pdf=' + encodeURIComponent(pdf);
  assert.equal((await handleRequest(req(path, {headers}), env, {fetchImpl})).status, 200);
  assert.equal((await handleRequest(req(path, {headers}), {...env}, {fetchImpl})).status, 200);
  assert.equal(calls, 1);
  const extra = await handleRequest(req('/api/getPaperData?pdf=https://arxiv.org/pdf/2006.11239', {headers}), env, {fetchImpl});
  assert.equal(extra.status, 429);
  assert.equal(calls, 1);
});

test('invalid, truncated and oversized provider output is rejected without exposing provider bodies', async () => {
  const malformed = study(); malformed.questions[0].answer = 8;
  assert.throws(() => normalizeStudy(malformed, pdf), /incomplete question/);
  const duplicate = study(); duplicate.flashcards[1].topic = duplicate.flashcards[0].topic;
  assert.throws(() => normalizeStudy(duplicate, pdf), /repeated/);
  for (const response of [
    new Response('provider-sensitive-detail', {status: 400}),
    Response.json({candidates: [{finishReason: 'MAX_TOKENS', content: {parts: [{text: 'provider-sensitive-detail'}]}}]}),
    new Response('provider-sensitive-detail'.repeat(10000), {headers: {'content-length': '240000'}}),
  ]) {
    await assert.rejects(generateStudy(pdf, {GOOGLE_API_KEY: 'synthetic-test-value'}, async () => response), error => {
      assert.equal(error.status, 502);
      assert.ok(!error.message.includes('provider-sensitive-detail'));
      return true;
    });
  }
});

test('unexpected database errors fail closed without leaking exception details', async t => {
  const env = setup(t);
  env.DB.prepare = () => { throw new Error('private-database-details'); };
  const response = await handleRequest(req('/health'), env);
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('private-database-details'));
});
