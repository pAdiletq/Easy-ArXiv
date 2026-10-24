import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SQLiteD1} from './helpers/d1.mjs';
import {handleFormulaAI} from '../cloudflare/edge-formula.mjs';

const SITE = 'https://easy-arxiv.pages.dev';
const IDENTITY = {owner: '0000-0001-2345-6789', extensionId: 'a'.repeat(32)};
const OTHER = {...IDENTITY, owner: '0000-0009-8765-4321'};
const NOW = Date.now();
const PDF = Buffer.from('%PDF-1.7\n% synthetic complete test document\n%%EOF');
const INPUT = {pdfBase64: PDF.toString('base64'), source: {label: 'Test paper', sourceId: 'synthetic-document:1'}};
const REF = {page: 3, quote: 'The density is given by the Gaussian expression.'};
const PAPER = {documentStatus: 'read', title: 'A synthetic Gaussian paper', authors: ['Synthetic Author'],
  summary: 'A test paper studies a normal density.', context: 'x is a real variable; mu is its center; sigma is positive.',
  glossary: [{symbol: 'sigma', meaning: 'A positive scale parameter.'}],
  formulas: [{expression: 'exp(-(x-mu)^2/(2*sigma^2))/(sigma*sqrt(2*pi))', name: 'Gaussian density',
    meaning: 'The density defined in the test paper.', page: 3, evidence: [REF]}], limitations: []};
const EXPLANATION = {status: 'ready', formulaName: 'Gaussian density', purpose: 'It describes the density defined by the paper.',
  applications: [{field: 'The test paper', explanation: 'A density model.', source: 'paper'},
    {field: 'Statistics', explanation: 'An illustrative wider use.', source: 'broader'}],
  workedExample: {assumptions: ['Illustrative values: mu=0, sigma=1, x=0; these are not reported measurements.'],
    steps: ['The exponent is zero.', 'Divide 1 by sqrt(2*pi).'], result: 'Approximately 0.39894.'},
  conclusion: 'The density changes with the specified center and scale.', evidence: [REF], limitations: []};

function provider(value, {status = 200, finishReason = 'STOP', extra} = {}) {
  return new Response(JSON.stringify(status === 200
    ? {candidates: [{finishReason, content: {parts: [{text: JSON.stringify(value)}, ...(extra || [])]}}]}
    : {error: {message: 'synthetic-test-provider-detail-must-not-leak'}}), {status, headers: {'content-type': 'application/json'}});
}
function fixture(t, responses = [PAPER, EXPLANATION], options = {}) {
  const db = new SQLiteD1(); t.after(() => db.close());
  const calls = [];
  const env = {DB: db, GOOGLE_API_KEY: 'synthetic-test-provider-key', ...options};
  const context = {now: () => NOW, fetchImpl: async (...args) => {
    calls.push(args);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next instanceof Response ? next : provider(next);
  }};
  async function request(path, body, {identity = IDENTITY, method = 'POST', headers = {}, localContext = context} = {}) {
    if (path === '/api/extension/explain' && body && typeof body === 'object' && !Object.hasOwn(body, 'pdfBase64')) body = {...body, pdfBase64: INPUT.pdfBase64};
    return handleFormulaAI(new Request(SITE + path, {method, headers: {'content-type': 'application/json', ...headers},
      ...(body === undefined ? {} : {body: typeof body === 'string' ? body : JSON.stringify(body)})}), env, localContext, identity);
  }
  return {db, env, calls, context, request};
}
async function upload(f) {
  const response = await f.request('/api/extension/papers', INPUT);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
function count(db, owner = IDENTITY.owner) {
  return db.sqlite.prepare('SELECT count FROM edge_quota_users WHERE owner=?').get(owner)?.count || 0;
}

test('only the two gated POST routes are handled and missing identity cannot incur provider usage', async t => {
  const f = fixture(t);
  assert.equal(await f.request('/api/other', undefined), null);
  assert.equal((await f.request('/api/extension/papers', undefined, {method: 'GET'})).status, 405);
  assert.equal((await f.request('/api/extension/papers', INPUT, {identity: null})).status, 401);
  assert.equal(f.calls.length, 0); assert.equal(count(f.db), 0);
});

test('the entire PDF is sent inline, its SHA-256 identifies owner-bound context, and raw PDF/key are never persisted', async t => {
  const f = fixture(t), result = await upload(f);
  assert.equal(result.cached, false); assert.equal(result.paper.title, PAPER.title);
  assert.equal(result.expiresAt, NOW + 86400000);
  const expected = Buffer.from(await crypto.subtle.digest('SHA-256', PDF)).toString('hex');
  assert.equal(result.contextId, expected);
  assert.deepEqual(result.source, INPUT.source);
  const [endpoint, init] = f.calls[0];
  assert.equal(new URL(endpoint).hostname, 'generativelanguage.googleapis.com');
  assert.ok(!endpoint.includes(f.env.GOOGLE_API_KEY));
  assert.equal(init.headers['x-goog-api-key'], f.env.GOOGLE_API_KEY);
  assert.equal(init.redirect, 'manual');
  const sent = JSON.parse(init.body);
  assert.deepEqual(sent.contents[0].parts[0], {inlineData: {mimeType: 'application/pdf', data: INPUT.pdfBase64}});
  assert.match(sent.systemInstruction.parts[0].text, /entire supplied scientific PDF/);
  assert.equal(count(f.db), 1);
  const stored = f.db.sqlite.prepare('SELECT key,payload,expires FROM edge_cache').get();
  assert.match(stored.key, new RegExp(IDENTITY.owner));
  assert.equal(stored.expires, result.expiresAt);
  assert.ok(!stored.payload.includes(INPUT.pdfBase64));
  assert.ok(!stored.payload.includes(f.env.GOOGLE_API_KEY));
  assert.ok(!JSON.stringify(result).includes(f.env.GOOGLE_API_KEY));
});

test('same-account PDF cache hits do not charge a quota or require a provider request', async t => {
  const f = fixture(t), first = await upload(f);
  delete f.env.GOOGLE_API_KEY;
  const second = await upload(f);
  assert.equal(second.cached, true); assert.equal(second.contextId, first.contextId);
  assert.deepEqual(second.paper, first.paper);
  assert.equal(f.calls.length, 1); assert.equal(count(f.db), 1);
});

test('PDF upload rejects truncation, non-PDF bytes, invalid base64, missing source and over-limit requests before quota', async t => {
  const f = fixture(t);
  for (const body of [
    {...INPUT, pdfBase64: 'javascript:fetch()'}, {...INPUT, pdfBase64: Buffer.from('plain text').toString('base64')},
    {...INPUT, pdfBase64: ''}, {...INPUT, source: {label: '', sourceId: 'test'}},
  ]) assert.equal((await f.request('/api/extension/papers', body)).status, 422);
  const oversized = Buffer.alloc(6 * 1024 * 1024 + 1, 65); PDF.copy(oversized);
  const tooLarge = await f.request('/api/extension/papers', {...INPUT, pdfBase64: oversized.toString('base64')});
  assert.equal(tooLarge.status, 413); assert.match((await tooLarge.json()).detail, /6 MiB|too large/);
  const declared = await f.request('/api/extension/papers', INPUT, {headers: {'content-length': '9000000'}});
  assert.equal(declared.status, 413);
  assert.equal(f.calls.length, 0); assert.equal(count(f.db), 0);
});

test('malformed UTF-8/JSON and non-object bodies cannot become uploads', async t => {
  const f = fixture(t);
  for (const input of ['{broken', '[]', 'null']) assert.equal((await f.request('/api/extension/papers', input)).status, 422);
  const invalid = await handleFormulaAI(new Request(SITE + '/api/extension/papers', {method: 'POST', body: new Uint8Array([255])}), f.env, f.context, IDENTITY);
  assert.equal(invalid.status, 422); assert.equal(f.calls.length, 0);
});

test('a partial or unreadable document is never saved or reported as complete', async t => {
  const f = fixture(t, [{...PAPER, documentStatus: 'partial'}, {...PAPER, documentStatus: 'unreadable'}]);
  for (let i = 0; i < 2; i++) {
    const response = await f.request('/api/extension/papers', INPUT);
    assert.equal(response.status, 422); assert.match((await response.json()).detail, /whole PDF|partial/);
  }
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM edge_cache').get().n, 0);
  assert.equal(count(f.db), 2, 'provider attempts retain the existing charged-attempt semantics');
});

test('cached contexts and selected-formula explanations are isolated by owner', async t => {
  const f = fixture(t, [PAPER, EXPLANATION, PAPER]), paper = await upload(f);
  const stolen = await f.request('/api/extension/explain', {contextId: paper.contextId, selectedText: 'density'}, {identity: OTHER});
  assert.equal(stolen.status, 404); assert.equal(f.calls.length, 1);
  const own = await f.request('/api/extension/explain', {contextId: paper.contextId, selectedText: PAPER.formulas[0].expression});
  assert.equal(own.status, 200);
  const otherUpload = await f.request('/api/extension/papers', INPUT, {identity: OTHER});
  assert.equal(otherUpload.status, 200); assert.equal((await otherUpload.json()).cached, false);
  assert.equal(f.calls.length, 3); assert.equal(count(f.db), 2); assert.equal(count(f.db, OTHER.owner), 1);
});

test('explanations reread the complete matching PDF with retained context, distinguish applications, and omit unsafe interactive code', async t => {
  const f = fixture(t, [PAPER, {...EXPLANATION, workedExample: {...EXPLANATION.workedExample,
    interactive: {expression: 'fetch("synthetic-test-url")', bindings: {}}}}]);
  const paper = await upload(f);
  const response = await f.request('/api/extension/explain', {contextId: paper.contextId, selectedText: PAPER.formulas[0].expression});
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, 'ready'); assert.equal(result.cached, false);
  assert.equal(result.applications[0].source, 'paper'); assert.equal(result.applications[1].source, 'broader');
  assert.ok(!('interactive' in result.workedExample));
  assert.deepEqual(result.evidence, [REF]);
  assert.ok(result.limitations.some(item => /can be wrong/.test(item)));
  const sent = JSON.parse(f.calls[1][1].body);
  const parts = sent.contents[0].parts;
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0].inlineData, {mimeType: 'application/pdf', data: INPUT.pdfBase64});
  const data = JSON.parse(parts[1].text);
  assert.equal(data.articleContext.title, PAPER.title); assert.equal(data.selectedText, PAPER.formulas[0].expression);
  assert.match(sent.systemInstruction.parts[0].text, /untrusted data/);
  assert.match(sent.systemInstruction.parts[0].text, /needs_context/);
  assert.match(sent.systemInstruction.parts[0].text, /need not occur in that inventory/);
  const again = await f.request('/api/extension/explain', {contextId: paper.contextId, selectedText: PAPER.formulas[0].expression});
  assert.equal((await again.json()).cached, true); assert.equal(count(f.db), 2); assert.equal(f.calls.length, 2);
});

test('an interactive worked example is compiled safely and returns its actual calculation and stated purpose', async t => {
  const f = fixture(t, [PAPER, {...EXPLANATION, workedExample: {...EXPLANATION.workedExample, interactive: {
    expression: PAPER.formulas[0].expression, bindings: JSON.stringify({x: 0, mu: 0, sigma: 1}),
    variable: 'x', min: -3, max: 3, purpose: 'Compare this illustrative density at different x values.',
    calculatedValue: 'An invented provider result must be replaced.',
  }}}]);
  const paper = await upload(f), result = await (await f.request('/api/extension/explain',
    {contextId: paper.contextId, selectedText: PAPER.formulas[0].expression})).json();
  const interactive = result.workedExample.interactive;
  assert.ok(interactive); assert.deepEqual(interactive.bindings, {x: 0, mu: 0, sigma: 1});
  assert.ok(Math.abs(interactive.calculatedValue - 0.3989422804014327) < 1e-12);
  assert.equal(interactive.variable, 'x'); assert.equal(interactive.min, -3); assert.equal(interactive.max, 3);
  assert.match(interactive.purpose, /illustrative/);
});

test('unsafe, undefined, shape-invalid or unmotivated interactive models are dropped without breaking a grounded explanation', async t => {
  const variants = [
    {expression: 'x+1', bindings: {x: 2}, purpose: ''},
    {expression: 'globalThis.fetch(x)', bindings: {x: 2}, purpose: 'Invalid execution.'},
    {expression: 'custom(x)', bindings: {x: 2}, purpose: 'Undefined function.'},
    {expression: '1/x', bindings: {x: 0}, purpose: 'Undefined value.'},
    {expression: 'dot(a,b)', bindings: {a: [1], b: [1,2]}, purpose: 'Incompatible vector shapes.'},
    {expression: 'x^2', bindings: {x: 1}, variable: 'z', min: -1, max: 1, purpose: 'Wrong variable.'},
    {expression: 'x^2', bindings: {x: 1}, variable: 'x', min: -1e100, max: 1, purpose: 'Unbounded range.'},
    {expression: 'x^2', bindings: '{broken', purpose: 'Malformed parameters.'},
  ];
  const f = fixture(t, [PAPER, ...variants.map(interactive => ({...EXPLANATION, workedExample: {...EXPLANATION.workedExample, interactive}}))]);
  const paper = await upload(f);
  for (let index = 0; index < variants.length; index++) {
    const response = await f.request('/api/extension/explain', {contextId: paper.contextId, selectedText: 'density '+index});
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, 'ready'); assert.ok(!('interactive' in result.workedExample));
  }
});

test('bounded matrix worked examples return calculated arrays without inventing a scalar graph', async t => {
  const f = fixture(t, [PAPER, {...EXPLANATION, workedExample: {...EXPLANATION.workedExample, interactive: {
    expression: 'matmul(A,v)', bindings: JSON.stringify({A: [[1,2],[3,4]], v: [5,6]}),
    purpose: 'Show this illustrative matrix-vector calculation.',
  }}}]);
  const paper = await upload(f), result = await (await f.request('/api/extension/explain',
    {contextId: paper.contextId, selectedText: 'density example'})).json();
  assert.deepEqual(result.workedExample.interactive.calculatedValue, [17,39]);
  assert.ok(!('variable' in result.workedExample.interactive));
});

test('unknown formulas clear every scientific/numerical claim rather than keeping provider inventions', async t => {
  const f = fixture(t, [PAPER, {...EXPLANATION, status: 'needs_context', limitations: ['The selected symbol is undefined in this context.']}]);
  const paper = await upload(f), response = await f.request('/api/extension/explain', {contextId: paper.contextId, selectedText: 'UnknownFunction(z)'});
  const result = await response.json();
  assert.equal(result.status, 'needs_context'); assert.equal(result.purpose, ''); assert.equal(result.formulaName, '');
  assert.deepEqual(result.applications, []); assert.deepEqual(result.evidence, []);
  assert.deepEqual(result.workedExample, {assumptions: [], steps: [], result: ''});
  assert.match(result.limitations[0], /undefined/);
});

test('a selected formula outside the first bounded inventory may use freshly extracted full-PDF evidence', async t => {
  const newReference = {page: 5, quote: 'A different expression is defined on this page.'};
  const f = fixture(t, [PAPER, {...EXPLANATION, formulaName: 'An expression outside the first inventory', evidence: [newReference]}]);
  const paper = await upload(f), result = await (await f.request('/api/extension/explain', {contextId: paper.contextId, selectedText: 'x'})).json();
  assert.equal(result.status, 'ready'); assert.deepEqual(result.evidence, [newReference]);
  assert.ok(result.limitations.some(item => /Verify them against the original PDF/.test(item)));
});

test('an explanation without full-PDF evidence cannot retain a ready status or invented claims', async t => {
  const f = fixture(t, [PAPER, {...EXPLANATION, evidence: []}]);
  const paper = await upload(f), result = await (await f.request('/api/extension/explain', {contextId: paper.contextId, selectedText: 'x'})).json();
  assert.equal(result.status, 'needs_context'); assert.deepEqual(result.evidence, []); assert.equal(result.conclusion, '');
});

test('explain requires a complete PDF with SHA-256 equal to the owner-bound initial context, including on cache hits', async t => {
  const f = fixture(t), paper = await upload(f), body = {contextId: paper.contextId, selectedText: 'x'};
  assert.equal((await f.request('/api/extension/explain', {...body, pdfBase64: null})).status, 422);
  const mismatch = {...body, pdfBase64: Buffer.from('%PDF-1.7\n% a different complete synthetic PDF\n%%EOF').toString('base64')};
  const response = await f.request('/api/extension/explain', mismatch);
  assert.equal(response.status, 409); assert.match((await response.json()).detail, /does not match/);
  assert.equal(count(f.db), 1); assert.equal(f.calls.length, 1);
  const own = await f.request('/api/extension/explain', body); assert.equal(own.status, 200);
  assert.equal((await f.request('/api/extension/explain', mismatch)).status, 409);
  assert.equal(count(f.db), 2); assert.equal(f.calls.length, 2);
});

test('missing/expired context and invalid formula selections do not consume AI quota', async t => {
  const f = fixture(t), paper = await upload(f);
  for (const body of [{contextId: 'bad', selectedText: 'x'}, {contextId: paper.contextId, selectedText: ''},
    {contextId: paper.contextId, selectedText: 'x'.repeat(2001)}]) assert.equal((await f.request('/api/extension/explain', body)).status, 422);
  assert.equal((await f.request('/api/extension/explain', {contextId: 'f'.repeat(64), selectedText: 'x'})).status, 404);
  const expired = await f.request('/api/extension/explain', {contextId: paper.contextId, selectedText: 'x'},
    {localContext: {...f.context, now: () => NOW + 86400001}});
  assert.equal(expired.status, 404); assert.equal(count(f.db), 1); assert.equal(f.calls.length, 1);
});

test('daily account and global limits atomically block new analysis while cache hits stay free', async t => {
  const f = fixture(t, [PAPER], {AI_USER_DAILY_LIMIT: '1', AI_GLOBAL_DAILY_LIMIT: '1'}), paper = await upload(f);
  const cached = await upload(f); assert.equal(cached.cached, true);
  const blocked = await f.request('/api/extension/explain', {contextId: paper.contextId, selectedText: 'x'});
  assert.equal(blocked.status, 429); assert.equal(f.calls.length, 1); assert.equal(count(f.db), 1);
  assert.equal((await f.request('/api/extension/papers', INPUT, {identity: OTHER})).status, 429);
  assert.equal(count(f.db, OTHER.owner), 0);
});

test('provider redirects, failures, cut-off generations and secret-bearing exceptions produce only controlled errors', async t => {
  const f = fixture(t, [provider(null, {status: 302}), provider(null, {status: 429}),
    provider(PAPER, {finishReason: 'MAX_TOKENS'}), new Error('synthetic-test-secret-in-exception')]);
  for (const expected of [502, 503, 502, 502]) {
    const response = await f.request('/api/extension/papers', INPUT);
    assert.equal(response.status, expected);
    const text = await response.text();
    assert.ok(!text.includes('synthetic-test')); assert.ok(!text.includes(INPUT.pdfBase64));
  }
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM edge_cache').get().n, 0);
});

test('provider output is bounded, strictly shaped and non-HTML text is not executed', async t => {
  const tooBig = new Response('a'.repeat(180001), {headers: {'content-type': 'application/json'}});
  const f = fixture(t, [tooBig, {...PAPER, authors: [42]}, {...PAPER, title: 'x'.repeat(1001)},
    {...PAPER, title: '<script>synthetic text only</script>\u0000'}]);
  for (let i = 0; i < 3; i++) assert.equal((await f.request('/api/extension/papers', INPUT)).status, 502);
  const last = await upload(f);
  assert.equal(last.paper.title, '<script>synthetic text only</script>');
  assert.equal(last.paper.title.includes('\u0000'), false);
});

test('database failures, missing bindings and invalid runtime model fail closed without leaking details', async t => {
  const f = fixture(t);
  f.env.DB = {prepare() { throw new Error('synthetic-test-private-db-detail'); }, batch() {}};
  const response = await f.request('/api/extension/papers', INPUT);
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('synthetic-test'));
  delete f.env.DB;
  assert.equal((await f.request('/api/extension/papers', INPUT)).status, 503);
  f.env.DB = f.db; f.env.GEMINI_MODEL = '../bad';
  assert.equal((await f.request('/api/extension/papers', INPUT)).status, 503); assert.equal(f.calls.length, 0);
});

test('public module has no URL downloader, dynamic code evaluation or logging of input/provider data', () => {
  const source = readFileSync(new URL('../cloudflare/edge-formula.mjs', import.meta.url), 'utf8');
  assert.ok(!/console\.|\beval\s*\(|new Function\s*\(/.test(source));
  assert.ok(!source.includes('fileUri'));
});
