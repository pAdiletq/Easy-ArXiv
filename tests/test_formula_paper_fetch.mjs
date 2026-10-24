import test from 'node:test';
import assert from 'node:assert/strict';
import {currentPaper, readSelectedPaper, registerPaperMessages, MAX_PDF_BYTES} from '../extensions/formula-lens/paper-fetch.js';
import {pdfSource} from '../extensions/formula-lens/selection.js';

const ID = 'a'.repeat(32);
const ORIGINAL = 'https://journal.example.test/research/paper.pdf?document=A&signature=synthetic-test-signed-link#page=3';
const PDF = new TextEncoder().encode('%PDF-1.7\n% complete synthetic test document\n%%EOF');
const event = () => {
  const listeners = new Set();
  return {listeners, addListener: value => listeners.add(value), removeListener: value => listeners.delete(value),
    emit: (...args) => [...listeners].map(listener => listener(...args))};
};
function fixture({url = ORIGINAL, id = 7} = {}) {
  const tab = {id, url}, calls = [];
  const api = {runtime: {id: ID, getURL: path => `chrome-extension://${ID}/${path}`, onMessage: event()},
    tabs: {query: async options => {calls.push(['query', options]); return [tab];},
      get: async tabId => {calls.push(['get', tabId]); return tab;}, onUpdated: event(), onRemoved: event()}};
  return {api, tab, calls, sourceId: pdfSource(url)?.sourceId};
}
function pdfResponse(bytes = PDF, headers = {}) { return new Response(bytes, {headers: {'content-type': 'application/pdf', ...headers}}); }
function trackedResponse(bytes = PDF, {declared} = {}) {
  let cancelled = false;
  const stream = new ReadableStream({start(controller) {controller.enqueue(bytes);}, cancel() {cancelled = true;}});
  return {response: new Response(stream, {headers: declared ? {'content-length': String(declared)} : {}}), cancelled: () => cancelled};
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

test('currentPaper reads only the active current-window tab and preserves its exact validated original link', async () => {
  const h = fixture(), result = await currentPaper(h.api);
  assert.equal(result.tabId, 7); assert.equal(result.source.originalUrl, ORIGINAL);
  assert.equal(result.source.sourceId, 'pdf:https://journal.example.test/research/paper.pdf');
  assert.ok(!result.source.label.includes('signature'));
  assert.deepEqual(h.calls, [['query', {active: true, currentWindow: true}]]);
  const arxiv = fixture({url: 'https://arxiv.org/pdf/1706.03762v7#page=4'});
  assert.equal((await currentPaper(arxiv.api)).source.sourceId, 'arxiv:1706.03762v7');
});

test('non-HTTPS, credential-bearing, non-PDF and absent active tabs are rejected before fetch', async () => {
  for (const url of ['http://example.test/file.pdf', 'file:///synthetic/file.pdf', 'data:application/pdf,synthetic',
    'https://user:synthetic-test-password@example.test/file.pdf', 'https://example.test/not-a-pdf']) {
    const h = fixture({url});
    await assert.rejects(currentPaper(h.api), /Open a PDF/);
  }
  const h = fixture(); h.api.tabs.query = async () => [];
  await assert.rejects(currentPaper(h.api), /Open a PDF/);
});

test('a source identifier mismatch never becomes an arbitrary URL request', async () => {
  const h = fixture(), calls = [];
  for (const sourceId of ['pdf:https://attacker.example.test/other.pdf', 'https://arbitrary.example.test/private', null]) {
    await assert.rejects(readSelectedPaper(sourceId, {api: h.api, fetcher: async (...args) => {calls.push(args); return pdfResponse();}}), /paper changed/);
  }
  assert.deepEqual(calls, []);
});

test('the same source identifier cannot conceal a changed query-document or a different tab with the same PDF', async () => {
  const h = fixture(), calls = [];
  const options = {api: h.api, fetcher: async (...args) => {calls.push(args); return pdfResponse();}};
  const originalSourceId = h.sourceId;
  h.tab.url = ORIGINAL.replace('document=A', 'document=B');
  assert.equal(pdfSource(h.tab.url).sourceId, originalSourceId);
  await assert.rejects(readSelectedPaper(originalSourceId, {...options, expectedOriginalURL: ORIGINAL, expectedTabId: 7}), /original paper tab changed/);
  h.tab.url = ORIGINAL; h.tab.id = 8;
  await assert.rejects(readSelectedPaper(originalSourceId, {...options, expectedOriginalURL: ORIGINAL, expectedTabId: 7}), /original paper tab changed/);
  assert.deepEqual(calls, []);
});

test('download uses the active original URL once, sends no cookies/referrer, rejects redirects, and returns all bytes without a URL bridge', async () => {
  const h = fixture(), calls = [];
  const result = await readSelectedPaper(h.sourceId, {api: h.api, fetcher: async (...args) => {calls.push(args); return pdfResponse();}});
  assert.equal(calls.length, 1); assert.equal(calls[0][0], ORIGINAL);
  assert.equal(calls[0][1].credentials, 'omit'); assert.equal(calls[0][1].referrerPolicy, 'no-referrer');
  assert.equal(calls[0][1].redirect, 'error'); assert.ok(calls[0][1].signal instanceof AbortSignal);
  assert.deepEqual(Buffer.from(result.pdfBase64, 'base64'), Buffer.from(PDF));
  assert.deepEqual(result.source, {sourceId: h.sourceId, label: pdfSource(ORIGINAL).label});
  assert.ok(!JSON.stringify(result).includes('signature'));
  assert.equal(h.api.tabs.onUpdated.listeners.size, 0); assert.equal(h.api.tabs.onRemoved.listeners.size, 0);
});

test('an already-aborted caller cannot start any PDF network request', async () => {
  const h = fixture(), controller = new AbortController(); controller.abort();
  let fetched = 0;
  await assert.rejects(readSelectedPaper(h.sourceId, {api: h.api, signal: controller.signal,
    fetcher: async () => {fetched++; return pdfResponse();}}), /cancelled/i);
  assert.equal(fetched, 0);
});

test('declared and streamed size limits reject the whole document without truncation', async () => {
  const h = fixture(), declared = trackedResponse(PDF, {declared: MAX_PDF_BYTES + 1});
  await assert.rejects(readSelectedPaper(h.sourceId, {api: h.api, fetcher: async () => declared.response}), /6 MB|6 MiB/);
  assert.equal(declared.cancelled(), true, 'rejecting a declared oversized response must stop its download');
  let cancelled = false;
  const tooLarge = new ReadableStream({start(controller) {
    controller.enqueue(PDF); controller.enqueue(new Uint8Array(MAX_PDF_BYTES));
  }, cancel() {cancelled = true;}});
  await assert.rejects(readSelectedPaper(h.sourceId, {api: h.api, fetcher: async () => new Response(tooLarge)}), /not be truncated/);
  assert.equal(cancelled, true);
});

test('a document exactly at the size limit retains the final byte', async () => {
  const h = fixture(), bytes = new Uint8Array(MAX_PDF_BYTES); bytes.set(PDF); bytes[bytes.length - 1] = 123;
  const result = await readSelectedPaper(h.sourceId, {api: h.api, fetcher: async () => pdfResponse(bytes)});
  const decoded = Buffer.from(result.pdfBase64, 'base64');
  assert.equal(decoded.byteLength, MAX_PDF_BYTES); assert.equal(decoded.at(-1), 123);
});

test('HTML/error responses, absent streams and fake PDF bodies never become analysis uploads', async () => {
  const h = fixture();
  for (const response of [new Response('<html>not a PDF</html>'), new Response('failure', {status: 503}),
    new Response(null), new Response(new Uint8Array([1, 2, 3]))]) {
    await assert.rejects(readSelectedPaper(h.sourceId, {api: h.api, fetcher: async () => response}), /PDF|downloaded|read safely/);
  }
});

test('a failed HTTP response body is cancelled instead of left downloading after rejection', async () => {
  const h = fixture(); let cancelled = false;
  const response = new Response(new ReadableStream({start(controller) {controller.enqueue(PDF);}, cancel() {cancelled = true;}}), {status: 503});
  await assert.rejects(readSelectedPaper(h.sourceId, {api: h.api, fetcher: async () => response}), /downloaded/);
  assert.equal(cancelled, true);
});

test('navigation, loading, tab closure and caller cancellation abort a pending download and detach listeners', async () => {
  for (const trigger of ['navigation', 'loading', 'close', 'caller']) {
    const h = fixture(), caller = new AbortController();
    let began;
    const started = new Promise(resolve => {began = resolve;});
    const job = readSelectedPaper(h.sourceId, {api: h.api, signal: caller.signal, fetcher: async (_url, {signal}) => {
      began(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Abort', 'AbortError')), {once: true}));
    }});
    await started;
    if (trigger === 'navigation') h.api.tabs.onUpdated.emit(7, {url: 'https://other.example.test/replaced.pdf'});
    if (trigger === 'loading') h.api.tabs.onUpdated.emit(7, {status: 'loading'});
    if (trigger === 'close') h.api.tabs.onRemoved.emit(7);
    if (trigger === 'caller') caller.abort();
    await assert.rejects(job, /cancelled|too long/i);
    assert.equal(h.api.tabs.onUpdated.listeners.size, 0); assert.equal(h.api.tabs.onRemoved.listeners.size, 0);
  }
});

test('a final navigation check rejects a different PDF/query even when no navigation event arrived', async () => {
  const h = fixture();
  await assert.rejects(readSelectedPaper(h.sourceId, {api: h.api, fetcher: async () => {
    h.tab.url = ORIGINAL.replace('document=A', 'document=B'); return pdfResponse();
  }}), /tab changed/);
});

test('changes in unrelated tabs do not cancel the active paper download', async () => {
  const h = fixture();
  const result = await readSelectedPaper(h.sourceId, {api: h.api, fetcher: async () => {
    h.api.tabs.onUpdated.emit(8, {url: 'https://other.example.test/file.pdf'}); h.api.tabs.onRemoved.emit(8);
    return pdfResponse();
  }});
  assert.equal(Buffer.from(result.pdfBase64, 'base64').byteLength, PDF.byteLength);
});

test('only this extension sidepanel may use the PDF bridge; websites, other extensions and arbitrary URL commands are ignored', async () => {
  const h = fixture(); registerPaperMessages(h.api);
  const listener = [...h.api.runtime.onMessage.listeners][0], replies = [];
  const own = {id: ID, url: h.api.runtime.getURL('sidepanel.html')};
  for (const sender of [{id: 'b'.repeat(32), url: own.url}, {id: ID, url: 'https://arxiv.org/pdf/1706.03762'},
    {id: ID, url: h.api.runtime.getURL('background.js')}, {id: ID, url: h.api.runtime.getURL('sidepanel.html.evil')}]) {
    assert.equal(listener({type: 'formula/paper-source'}, sender, result => replies.push(result)), false);
  }
  for (const message of [{type: 'formula/fetch-url', url: 'https://arbitrary.example.test/file.pdf'},
    {type: 'fetch', url: ORIGINAL}, {url: ORIGINAL}]) assert.equal(listener(message, own, result => replies.push(result)), false);
  assert.deepEqual(h.calls, []); assert.deepEqual(replies, []);
  assert.equal(listener({type: 'formula/paper-source', url: 'https://arbitrary.example.test/private'}, own, result => replies.push(result)), true);
  await settle();
  assert.equal(replies.length, 1); assert.equal(replies[0].ok, true);
  assert.equal(replies[0].data.source.originalUrl, ORIGINAL);
});

test('the trusted read command still ignores message URLs and validates its source against the active tab', async t => {
  const h = fixture(), urls = []; registerPaperMessages(h.api);
  t.mock.method(globalThis, 'fetch', async url => {urls.push(url); return pdfResponse();});
  const listener = [...h.api.runtime.onMessage.listeners][0];
  const response = await new Promise(resolve => {
    assert.equal(listener({type: 'formula/read-paper', sourceId: h.sourceId, url: 'https://attacker.example.test/ignored.pdf'},
      {id: ID, url: h.api.runtime.getURL('sidepanel.html') + '?view=paper#top'}, resolve), true);
  });
  assert.equal(response.ok, true); assert.deepEqual(urls, [ORIGINAL]);
  const rejected = await new Promise(resolve => listener({type: 'formula/read-paper', sourceId: 'pdf:https://attacker.example.test/ignored.pdf'},
    {id: ID, url: h.api.runtime.getURL('sidepanel.html')}, resolve));
  assert.equal(rejected.ok, false); assert.equal(urls.length, 1);
  const drifted = await new Promise(resolve => listener({type: 'formula/read-paper', sourceId: h.sourceId,
    expectedOriginalURL: ORIGINAL.replace('document=A', 'document=B'), expectedTabId: 7},
    {id: ID, url: h.api.runtime.getURL('sidepanel.html')}, resolve));
  assert.equal(drifted.ok, false); assert.equal(urls.length, 1);
  const wrongTab = await new Promise(resolve => listener({type: 'formula/read-paper', sourceId: h.sourceId,
    expectedOriginalURL: ORIGINAL, expectedTabId: 99}, {id: ID, url: h.api.runtime.getURL('sidepanel.html')}, resolve));
  assert.equal(wrongTab.ok, false); assert.equal(urls.length, 1);
});
