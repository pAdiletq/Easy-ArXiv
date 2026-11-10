import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPdfURL, handleResearch, parseFeed, parseMonthlyStats, queryArxiv, searchParams, ResearchError } from '../cloudflare/edge-research.mjs';

const FEED = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
<opensearch:totalResults>42</opensearch:totalResults>
<entry><id>http://arxiv.org/abs/1706.03762v7</id><title> Attention &amp; All\n You Need </title>
<summary>A research paper about attention.</summary><published>2017-06-12T00:00:00Z</published><updated>2023-08-02T00:00:00Z</updated>
<author><name>Ashish Vaswani</name></author><author><name>Noam Shazeer</name></author>
<category term="cs.CL"/><category term="cs.LG"/><link title="pdf" href="http://arxiv.org/pdf/1706.03762v7"/>
</entry></feed>`;
const NOW = Date.parse('2026-10-23T12:00:00Z');
function dependencies(overrides = {}) {
  return { now: () => NOW, cache: new Map(), store: { acquireArxivSlot: async () => 0 },
    fetchImpl: async () => new Response(FEED), ...overrides };
}
const request = path => new Request('https://easy-arxiv.pages.dev' + path);

test('PDF links canonicalize versions, optional extensions and legacy identifiers', () => {
  assert.equal(canonicalPdfURL('https://www.arxiv.org/abs/1706.03762v7'), 'https://arxiv.org/pdf/1706.03762v7');
  assert.equal(canonicalPdfURL('https://export.arxiv.org/pdf/hep-th/9901001.pdf'), 'https://arxiv.org/pdf/hep-th/9901001');
  assert.equal(canonicalPdfURL('https://arxiv.org/pdf/math.GT/0309136v2/'), 'https://arxiv.org/pdf/math.GT/0309136v2');
});

test('PDF links reject arbitrary hosts, credentials, query strings and encoded path tricks', () => {
  for (const url of ['http://arxiv.org/pdf/1706.03762', 'https://arxiv.org.evil.test/pdf/1706.03762',
    'https://user:secret@arxiv.org/pdf/1706.03762', 'https://arxiv.org:444/pdf/1706.03762',
    'https://arxiv.org/pdf/1706.03762?download=1', 'https://arxiv.org/pdf/1706.03762#part',
    'https://arxiv.org/pdf/1706.03762%2f', 'https://arxiv.org/html/1706.03762', '1706.03762', null]) {
    assert.throws(() => canonicalPdfURL(url), error => error instanceof ResearchError && error.status === 422);
  }
});

test('Atom XML maps titles, entities, authors, categories, metadata and pagination', () => {
  const result = parseFeed(FEED, 15);
  assert.equal(result.total, 42); assert.equal(result.start, 15); assert.equal(result.has_more, true);
  assert.equal(result.returned, 1); assert.equal(result.source, 'arXiv API');
  assert.deepEqual(result.papers[0], { id: '1706.03762v7', title: 'Attention & All You Need',
    summary: 'A research paper about attention.', authors: ['Ashish Vaswani', 'Noam Shazeer'],
    published: '2017-06-12T00:00:00Z', updated: '2023-08-02T00:00:00Z',
    link: 'https://arxiv.org/abs/1706.03762v7', pdf_url: 'https://arxiv.org/pdf/1706.03762v7',
    categories: ['cs.CL', 'cs.LG'], reading_time: '1 min abstract' });
});

test('Atom parser resolves prefixed namespace names rather than matching tag strings', () => {
  const prefixed = `<a:feed xmlns:a="http://www.w3.org/2005/Atom" xmlns:o="http://a9.com/-/spec/opensearch/1.1/">
  <o:totalResults>1</o:totalResults><a:entry><a:id>http://arxiv.org/abs/1706.03762</a:id>
  <a:title>Namespaced paper</a:title><a:summary>Text</a:summary><a:author><a:name>Researcher</a:name></a:author>
  <a:link title="pdf" href="https://arxiv.org/pdf/1706.03762"/></a:entry></a:feed>`;
  assert.equal(parseFeed(prefixed).papers[0].title, 'Namespaced paper');
  assert.equal(parseFeed(prefixed).total, 1);
  assert.equal(parseFeed(prefixed).has_more, false);
});

test('Malformed XML, non-Atom documents and DTD/entity declarations are rejected', () => {
  for (const xml of ['<feed><entry></feed>', '<feed xmlns="https://evil.example/Atom"/>',
    '<html><body>blocked</body></html>', '<!DOCTYPE feed [<!ENTITY bomb "expanded">]>' + FEED,
    '<!ENTITY external SYSTEM "https://evil.example/secret">' + FEED]) {
    assert.throws(() => parseFeed(xml), error => error.status === 502);
  }
  assert.throws(() => parseFeed(' '.repeat(64 * 1024 + 1)), error => error.status === 502);
  assert.throws(() => parseFeed('<!--' + 'é'.repeat(32768) + '--><feed xmlns="http://www.w3.org/2005/Atom"/>'), error => error.status === 502);
});

test('arXiv API error feeds fail honestly and unsafe PDF links are omitted', () => {
  assert.throws(() => parseFeed(FEED.replace('http://arxiv.org/abs/1706.03762v7', 'http://arxiv.org/api/errors#bad_query')),
    error => error.status === 502);
  const result = parseFeed(FEED.replace('http://arxiv.org/pdf/1706.03762v7', 'https://evil.example/paper.pdf'));
  assert.deepEqual(result.papers, []); assert.equal(result.has_more, false);
});

test('search parameters handle literal topics, dates, arXiv IDs and supported sorting aliases', () => {
  assert.deepEqual(searchParams('attention "all:malicious"', 'oldest', 'descending', '2020-01-01', '2021-12-31', 30, 15), {
    sortBy: 'submittedDate', sortOrder: 'ascending', start: 30, max_results: 15,
    search_query: 'all:"attention all:malicious" AND submittedDate:[202001010000 TO 202112312359]',
  });
  assert.equal(searchParams('hep-th/9901001').id_list, 'hep-th/9901001');
  assert.equal(searchParams('https://arxiv.org/abs/1706.03762').id_list, '1706.03762');
  for (const args of [[''], ['x', 'unknown'], ['x', 'relevance', 'random'], ['x', 'relevance', 'descending', '2026-02-30'],
    ['x', 'relevance', 'descending', '2026-04-01', '2026-03-01']]) {
    assert.throws(() => searchParams(...args), error => error.status === 422);
  }
});

test('search acquires durable upstream slot once and serves repeated searches from cache', async () => {
  let slots = 0, calls = 0, slept = 0;
  const deps = dependencies({ store: { acquireArxivSlot: async time => { assert.equal(time, NOW); slots++; return 3000; } },
    sleep: async delay => { slept += delay; }, fetchImpl: async (url, options) => {
      calls++; assert.equal(new URL(url).origin, 'https://export.arxiv.org');
      assert.equal(new URL(url).searchParams.get('search_query'), 'all:"attention"');
      assert.equal(options.redirect, 'manual'); return new Response(FEED);
    } });
  const params = searchParams('attention');
  const first = await queryArxiv(params, {}, deps), second = await queryArxiv(params, {}, deps);
  assert.deepEqual(first, second); assert.equal(slots, 1); assert.equal(calls, 1); assert.equal(slept, 3000);
});

test('research invokes receiver-sensitive Worker fetch without binding its dependency container', async () => {
  let calls = 0;
  // Node fetch tolerates arbitrary receivers, unlike Cloudflare workerd. Model
  // that native contract explicitly so a real outbound fetch cannot be mistaken
  // for an arXiv outage merely because tests use permissive arrow-function mocks.
  function workerFetch(url) {
    assert.ok(this === undefined || this === globalThis, 'Worker fetch requires the global receiver');
    calls++;
    return Promise.resolve(new Response(url.includes('/stats/') ?
      'month,submissions,historical_delta\n2026-08,31173,0\n2026-09,40363,0\n2026-10,31672,0\n' : FEED));
  }
  const deps = dependencies({ fetchImpl: workerFetch });
  const search = await handleResearch(request('/api/search?query=attention'), {}, deps);
  assert.equal(search.status, 200);
  assert.equal((await search.json()).papers.length, 1);
  const stats = await handleResearch(request('/api/stats'), {}, deps);
  assert.equal(stats.status, 200);
  assert.deepEqual((await stats.json()).months.map(month => month.value), [31173, 40363]);
  assert.equal(calls, 2);
});

test('D1 cached responses bypass upstream acquisition and network requests', async () => {
  const cached = parseFeed(FEED); let bound;
  const db = { prepare(sql) { assert.match(sql, /^SELECT payload, expires/); return {
    bind(...values) { bound = values; return this; }, first: async () => ({ payload: JSON.stringify(cached), expires: NOW + 1000 }),
  }; } };
  const result = await queryArxiv(searchParams('attention'), { DB: db }, dependencies({ store: null,
    fetchImpl: async () => assert.fail('cache hit must not fetch') }));
  assert.equal(result.papers[0].title, 'Attention & All You Need');
  assert.equal(bound[1], NOW);
});

test('expired public cache entries do not replace fresh network results', async () => {
  let fetched = false;
  const cache = new Map([['arxiv:' + JSON.stringify({ max_results: 15, search_query: 'all:"attention"', sortBy: 'relevance', sortOrder: 'descending', start: 0 }),
    { payload: { papers: [] }, expires: NOW - 1 }]]);
  const result = await queryArxiv(searchParams('attention'), {}, dependencies({ cache,
    fetchImpl: async () => { fetched = true; return new Response(FEED); } }));
  assert.equal(fetched, true); assert.equal(result.papers.length, 1);
});

test('overloaded global arXiv queue and missing durable state fail closed', async () => {
  for (const store of [null, { acquireArxivSlot: async () => 30000 }, { acquireArxivSlot: async () => -1 }]) {
    await assert.rejects(queryArxiv(searchParams('attention'), {}, dependencies({ store,
      fetchImpl: async () => assert.fail('busy search must not fetch') })), error => error.status === 503);
  }
});

test('internal arXiv queries validate the 15-paper limit before cache, database or network access', async () => {
  const deps = dependencies({ cache: { get: () => assert.fail('invalid size must fail before cache access') },
    store: { acquireArxivSlot: async () => assert.fail('invalid size must not reserve a slot') },
    fetchImpl: async () => assert.fail('invalid size must not fetch') });
  for (const maximum of [0, 16, 50, 1.5, '12', undefined]) {
    await assert.rejects(queryArxiv({ ...searchParams('attention'), max_results: maximum }, {}, deps), error => error.status === 422);
  }
});

test('Atom responses with more than 15 entries fail instead of silently changing pagination', () => {
  const entry = '<entry><id>http://arxiv.org/abs/1706.03762</id><title>A paper</title><link title="pdf" href="https://arxiv.org/pdf/1706.03762"/></entry>';
  const feed = count => '<feed xmlns="http://www.w3.org/2005/Atom">' + entry.repeat(count) + '</feed>';
  assert.equal(parseFeed(feed(15)).returned, 15);
  assert.throws(() => parseFeed(feed(16)), error => error.status === 502);
});

test('upstream errors and unsafe redirects do not leak response bodies or fetch other hosts', async () => {
  const secretBody = 'private upstream detail';
  const response = await handleResearch(request('/api/search?query=attention'), {}, dependencies({
    fetchImpl: async () => new Response(secretBody, { status: 429 }),
  }));
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /private upstream/);
  let calls = 0;
  const redirect = await handleResearch(request('/api/search?query=attention'), {}, dependencies({ fetchImpl: async () => {
    calls++; return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } });
  } }));
  assert.equal(redirect.status, 502); assert.equal(calls, 1);
});

test('oversized upstream responses are rejected before XML parsing', async () => {
  const response = await handleResearch(request('/api/search?query=attention'), {}, dependencies({ fetchImpl: async () =>
    new Response(FEED, { headers: { 'content-length': String(64 * 1024 + 1) } }) }));
  assert.equal(response.status, 502);
  const streamed = await handleResearch(request('/api/search?query=attention'), {}, dependencies({ fetchImpl: async () =>
    new Response('x'.repeat(64 * 1024 + 1)) }));
  assert.equal(streamed.status, 502);
});

test('research endpoints preserve search, single-paper, browse and validation contracts', async () => {
  const deps = dependencies();
  let response = await handleResearch(request('/api/search_papers?query=attention&sortBy=newest&dateFrom=2020-01-01'), {}, deps);
  assert.equal(response.status, 200); assert.equal((await response.json()).returned, 1);
  response = await handleResearch(request('/api/paper?pdf=https%3A%2F%2Farxiv.org%2Fabs%2F1706.03762'), {}, deps);
  assert.equal(response.status, 200); assert.equal((await response.json()).id, '1706.03762v7');
  for (const path of ['/api/search', '/api/search?query=x&max_results=16', '/api/search?query=x&max_results=51', '/api/search?query=x&start=-1',
    '/api/search?query=x&start=1.5', '/api/search?query=x&date_from=2026-02-29']) {
    response = await handleResearch(request(path), {}, deps); assert.equal(response.status, 422, path);
  }
  let browse;
  response = await handleResearch(request('/api/recent_papers'), {}, dependencies({ fetchImpl: async url => {
    browse = new URL(url).searchParams; return new Response(FEED);
  } }));
  assert.equal(response.status, 200); assert.equal(browse.get('sortBy'), 'submittedDate');
  assert.equal(browse.get('search_query'), 'submittedDate:[199107010000 TO 202610232359]');
  assert.equal(await handleResearch(request('/api/session'), {}, deps), null);
  assert.equal((await handleResearch(new Request('https://easy-arxiv.pages.dev/api/search', { method: 'POST' }), {}, deps)).status, 405);
});

test('the 12-paper page size used by the search UI remains supported', async () => {
  let maximum;
  const response = await handleResearch(request('/api/search_papers?query=attention&max_results=12'), {}, dependencies({
    fetchImpl: async url => { maximum = new URL(url).searchParams.get('max_results'); return new Response(FEED); },
  }));
  assert.equal(response.status, 200); assert.equal(maximum, '12');
  assert.equal((await response.json()).returned, 1);
});

test('statistics retain their separate 256KiB CSV allowance', async () => {
  const csv = 'month,submissions,notes\n' + Array.from({ length: 600 }, (_, i) =>
    `2026-${String(i % 9 + 1).padStart(2, '0')},100,${'note '.repeat(25)}`).join('\n');
  assert.ok(csv.length > 64 * 1024); assert.ok(csv.length < 256 * 1024);
  const response = await handleResearch(request('/api/stats'), {}, dependencies({ fetchImpl: async () => new Response(csv) }));
  assert.equal(response.status, 200); assert.equal((await response.json()).months.length, 9);
});

test('single paper endpoint returns 404 for an empty valid Atom result', async () => {
  const response = await handleResearch(request('/api/paper?pdf=https%3A%2F%2Farxiv.org%2Fpdf%2F1706.03762'), {}, dependencies({
    fetchImpl: async () => new Response('<feed xmlns="http://www.w3.org/2005/Atom"/>'),
  }));
  assert.equal(response.status, 404);
});

test('autocomplete uses local topics and cached titles without arXiv requests', async () => {
  const deps = dependencies({ fetchImpl: async () => assert.fail('autocomplete must not hit arXiv') });
  let response = await handleResearch(request('/api/suggestions?query=quantum'), {}, deps);
  assert.equal(response.status, 200);
  const topic = await response.json(); assert.equal(topic.suggestions.length, 3);
  assert.equal(topic.suggestions[0].type, 'topic');
  deps.cache.set('arxiv:example', { payload: parseFeed(FEED), expires: NOW + 1000 });
  response = await handleResearch(request('/api/suggestions?query=attention'), {}, deps);
  const payload = await response.json(), paper = payload.suggestions.find(item => item.type === 'paper');
  assert.equal(paper.id, '1706.03762'); assert.equal(paper.label, 'Attention & All You Need');
  response = await handleResearch(request('/api/suggestions?query='), {}, deps);
  assert.deepEqual(await response.json(), { suggestions: [] });
});

test('monthly CSV excludes partial current month and returns last nine completed periods', () => {
  const rows = ['month,submissions', ...Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')},${(i + 1) * 100}`)].join('\r\n');
  const months = parseMonthlyStats('\uFEFF' + rows, new Date(NOW));
  assert.equal(months.length, 9); assert.equal(months[0].period, '2026-01');
  assert.deepEqual(months.at(-1), { label: 'Sep', value: 900, period: '2026-09' });
  assert.throws(() => parseMonthlyStats('date,value\n2026-01,20\n2026-02,30'), /columns/);
  assert.throws(() => parseMonthlyStats('month,submissions\n2026-01,20'), /Not enough/);
});

test('statistics use official mirror fallback, preserve source attribution, then cache success', async () => {
  const urls = [];
  const deps = dependencies({ fetchImpl: async url => {
    urls.push(url); return urls.length === 1 ? new Response('unavailable', { status: 503 }) :
      new Response('month,submissions\n2025-12,100\n2026-01,200\n2026-10,999');
  } });
  const first = await handleResearch(request('/api/stats'), {}, deps);
  const data = await first.json(); assert.equal(first.status, 200);
  assert.equal(data.dataset_url, 'https://export.arxiv.org/stats/get_monthly_submissions');
  assert.equal(data.source_url, 'https://arxiv.org/stats/monthly_submissions');
  assert.equal(data.period_label, 'Dec 2025–Jan 2026'); assert.equal(data.stale, false);
  await handleResearch(request('/api/stats'), {}, deps); assert.equal(urls.length, 2);
});

test('statistics outages use bounded stale data and shared retry backoff, never invented values', async () => {
  let calls = 0;
  const cache = new Map(), deps = dependencies({ cache, fetchImpl: async () => { calls++; return new Response('down', { status: 503 }); } });
  let response = await handleResearch(request('/api/stats'), {}, deps);
  assert.equal(response.status, 503); assert.equal(calls, 2);
  response = await handleResearch(request('/api/stats'), {}, deps);
  assert.equal(response.status, 503); assert.equal(calls, 2);
  cache.set('stats:monthly', { payload: { fetched: NOW - 86400000, data: { months: [{ value: 123 }], stale: false } }, expires: NOW + 86400000 });
  response = await handleResearch(request('/api/stats'), {}, deps);
  assert.equal(response.status, 200); assert.equal((await response.json()).stale, true);
  assert.equal(calls, 2);
});
