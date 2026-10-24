import assert from 'node:assert/strict';
import test from 'node:test';
import {arxivPDFSource, pdfSource, samePDFDocument, isLocalPreview, validSelection} from '../extensions/formula-lens/selection.js';
import {createFormulaPanelBridge} from '../extensions/formula-lens/sidepanel.js';

const ARXIV = 'https://arxiv.org/pdf/1706.03762';
const PDF = 'https://papers.example.test/folder/Formula%20%CE%B1.PDF?download=1&sig=Synthetic#page=4';

test('accepts different strict arXiv paper IDs and preserves original URLs without an equation gate', () => {
  for (const originalUrl of [ARXIV, ARXIV + 'v7', ARXIV + '.pdf', ARXIV + '#page=4',
    ARXIV + '?download=1#page=4', 'https://arxiv.org/pdf/hep-th/9901001v2.pdf',
    'https://arxiv.org/pdf/math.GT/0309136', 'https://arxiv.org/pdf/2006.11239']) {
    assert.equal(pdfSource(originalUrl)?.originalUrl, originalUrl);
    assert.equal(arxivPDFSource(originalUrl)?.originalUrl, originalUrl);
  }
  assert.deepEqual(pdfSource(ARXIV + 'v7?download=1#page=9'), {
    originalUrl: ARXIV + 'v7?download=1#page=9', sourceId: 'arxiv:1706.03762v7',
    label: 'arxiv.org · 1706.03762v7', paperId: '1706.03762', versionedId: '1706.03762v7'});
});

test('general HTTPS PDFs use a host and decoded filename label without query or fragment tokens', () => {
  assert.deepEqual(pdfSource(PDF), {originalUrl: PDF,
    sourceId: 'pdf:https://papers.example.test/folder/Formula%20%CE%B1.PDF',
    label: 'papers.example.test · Formula α.PDF'});
  assert.equal(arxivPDFSource(PDF), null);
  for (const url of ['https://journal.example.test/article.pdf', 'https://data.example.test:443/A.PdF#page=2']) {
    assert.equal(pdfSource(url)?.originalUrl, url);
  }
});

test('source validation rejects other schemes, credentials, unusual ports, malformed paths and control characters', () => {
  for (const url of [null, {}, '', 'http://papers.example.test/report.pdf', 'file:///synthetic/report.pdf',
    'data:application/pdf,synthetic', 'javascript:alert(1)', 'https://user:pass@papers.example.test/report.pdf',
    'https://@papers.example.test/report.pdf', 'https://papers.example.test:444/report.pdf',
    'https:///papers.example.test/report.pdf', 'https://%70apers.example.test/report.pdf',
    'https://papers.example.test/report.pdf/', 'https://papers.example.test/report.pdf.exe',
    'https://papers.example.test/download?file=report.pdf', 'https://papers.example.test/report%2Epdf',
    'https://papers.example.test/report%0a.pdf', 'https://papers.example.test/report%5c.pdf',
    'https://papers.example.test/report%2f.pdf', 'https://papers.example.test/report%ZZ.pdf',
    'https://papers.example.test/re\nport.pdf', 'https://papers.example.test\\report.pdf',
    'https://arxiv.org/abs/1706.03762', ARXIV + 'v0', ARXIV + '/',
    'https://arxiv.org/pdf/%31%37%30%36.03762', 'https://arxiv.org/pdf/not-a-paper.pdf',
    'https://papers.example.test/' + 'x'.repeat(8192) + '.pdf']) {
    assert.equal(pdfSource(url), null, String(url));
  }
});

test('document equality ignores a page fragment but preserves query document identity and origin', () => {
  assert.equal(samePDFDocument(PDF, PDF.replace('#page=4', '#page=9')), true);
  assert.equal(samePDFDocument(PDF, PDF.replace('download=1', 'download=2')), false);
  assert.equal(samePDFDocument(PDF, PDF.replace('papers.example.test', 'other.example.test')), false);
  assert.equal(samePDFDocument(ARXIV, ARXIV + 'v2'), false);
  assert.equal(samePDFDocument('file:///synthetic/a.pdf', 'file:///synthetic/a.pdf'), false);
});

test('bounded selections retain mathematical case, spacing, Unicode and arbitrary text for the editor', () => {
  for (const text of [' A*x² + a\n', '𝑨 = α + A', 'x'.repeat(2000), 'text requiring correction']) {
    assert.equal(validSelection(text), true);
  }
  for (const text of [null, {}, '', ' \n\t', 'x'.repeat(2001)]) assert.equal(validSelection(text), false);
});

test('preview requires the explicit loopback HTTP panel flag', () => {
  assert.equal(isLocalPreview('http://127.0.0.1:5055/local/sidepanel.html?preview=1'), true);
  for (const url of ['http://localhost:5055/sidepanel.html?preview=1', 'https://127.0.0.1/sidepanel.html?preview=1',
    'http://127.0.0.1:5055/sidepanel.html', 'http://127.0.0.1:5055/sidepanel.html?preview=true',
    'http://user@127.0.0.1:5055/sidepanel.html?preview=1', 'http://127.0.0.1:5055/options.html?preview=1',
    'https://arxiv.org/pdf/1706.03762?preview=1', 'chrome-extension://test/sidepanel.html?preview=1',
    'http://127.0.0.1.evil.test/sidepanel.html?preview=1', 'http://127.0.0.1:5055/viewer.html?preview=1']) {
    assert.equal(isLocalPreview(url), false, url);
  }
});

function event() {
  const listeners = [];
  return {addListener: callback => listeners.push(callback), emit: (...args) => {
    for (const callback of listeners) callback(...args);
  }};
}
function fakeDocument() {
  const emitted = [], nodes = new Map();
  for (const id of ['selectedSource', 'selectionFeedback', 'previewBadge', 'previewExample']) {
    const click = event();
    nodes.set(id, {hidden: true, textContent: '', href: '',
      removeAttribute(name) { delete this[name]; }, addEventListener: (_, callback) => click.addListener(callback),
      click: () => click.emit()});
  }
  return {emitted, nodes, getElementById: id => nodes.get(id),
    dispatchEvent: value => {emitted.push({type: value.type, detail: value.detail}); return true;}};
}
function record(originalUrl = PDF, rawText = ' F(x) = A*x² + a\n') {
  return {originalUrl, sourceId: pdfSource(originalUrl).sourceId, rawText, updatedAt: 123};
}
function panelHarness({query = null, get = null, records = {'formula:1': record()}} = {}) {
  const doc = fakeDocument(), calls = [];
  const api = {runtime: {id: 'synthetic-extension'}, storage: {onChanged: event(), session: {
    get: async key => {calls.push(['get', key]); return get ? get(key) : {[key]: records[key]};}}},
    tabs: {onActivated: event(), onUpdated: event(), onRemoved: event(), query: async () => {
      calls.push(['query']); return query ? query() : [{id: 1, url: PDF, status: 'complete'}];}}};
  const bridge = createFormulaPanelBridge({api, doc, href: 'chrome-extension://synthetic/sidepanel.html'});
  return {api, doc, calls, bridge};
}
async function settle() {for (let i = 0; i < 12; i++) await Promise.resolve();}
const selections = doc => doc.emitted.filter(value => value.type === 'formula-selection');

test('panel dispatches the raw general selection and safe source label instead of forcing an Attention model', async () => {
  const h = panelHarness(); await settle();
  assert.deepEqual(selections(h.doc).map(value => value.detail), [{rawText: record().rawText, source: pdfSource(PDF)}]);
  const link = h.doc.nodes.get('selectedSource');
  assert.equal(link.href, PDF); assert.equal(link.textContent, 'papers.example.test · Formula α.PDF');
  assert.equal(link.hidden, false);
  const before = h.calls.length;
  h.api.storage.onChanged.emit({'formula:2': {newValue: record()}}, 'session'); await settle();
  assert.equal(h.calls.length, before);
});

test('panel rejects forged source IDs and different signed document URLs', async () => {
  for (const invalid of [{...record(), sourceId: 'pdf:forged'}, record(PDF.replace('download=1', 'download=2'))]) {
    const h = panelHarness({records: {'formula:1': invalid}}); await settle();
    assert.equal(selections(h.doc).length, 0); assert.equal(h.doc.emitted.at(-1).type, 'formula-clear');
    assert.equal(h.doc.nodes.get('selectedSource').hidden, true);
  }
});

test('delayed storage for a previous tab cannot replace or clear the newer active tab selection', async () => {
  let rejectOld, active = 1;
  const oldRead = new Promise((_, reject) => {rejectOld = reject;});
  const second = 'https://other.example.test/next.pdf';
  const h = panelHarness({query: () => [{id: active, url: active === 1 ? PDF : second}],
    get: key => key === 'formula:1' ? oldRead : {[key]: record(second, 'y = sin(x)')}});
  await settle(); active = 2; h.api.tabs.onActivated.emit({tabId: 2}); await settle();
  assert.equal(selections(h.doc).at(-1).detail.rawText, 'y = sin(x)');
  const before = h.doc.emitted.length; rejectOld(Error('synthetic expired read')); await settle();
  assert.equal(h.doc.emitted.length, before);
});

test('navigation immediately clears the panel and prevents old session reads from reappearing while loading', async () => {
  let finish;
  const waiting = new Promise(resolve => {finish = resolve;});
  const h = panelHarness({get: () => waiting}); await settle();
  h.api.tabs.onUpdated.emit(1, {status: 'loading'});
  assert.equal(h.doc.emitted.at(-1).type, 'formula-clear');
  finish({'formula:1': record()}); await settle();
  h.api.storage.onChanged.emit({'formula:1': {newValue: record()}}, 'session'); await settle();
  assert.equal(selections(h.doc).length, 0);
  assert.equal(h.calls.filter(value => value[0] === 'get').length, 1);
});

test('local files receive a clear unsupported message without reading session selections', async () => {
  const h = panelHarness({query: () => [{id: 1, url: 'file:///synthetic/report.pdf'}]}); await settle();
  assert.equal(selections(h.doc).length, 0);
  assert.match(h.doc.emitted.at(-1).detail.message, /file:\/\//);
  assert.equal(h.calls.some(value => value[0] === 'get'), false);
});

test('a PDF fragment update clears the old selection without permanently blocking the next user selection', async () => {
  let currentURL = PDF;
  const records = {'formula:1': record()};
  const h = panelHarness({records, query: () => [{id: 1, url: currentURL, status: 'complete'}]}); await settle();
  assert.equal(selections(h.doc).length, 1);
  currentURL = PDF.replace('#page=4', '#page=5');
  h.api.tabs.onUpdated.emit(1, {url: currentURL});
  assert.equal(h.doc.emitted.at(-1).type, 'formula-clear');
  records['formula:1'] = record(currentURL, 'g(x) = x^3');
  h.api.storage.onChanged.emit({'formula:1': {newValue: records['formula:1']}}, 'session'); await settle();
  assert.equal(selections(h.doc).length, 2);
  assert.equal(selections(h.doc).at(-1).detail.rawText, 'g(x) = x^3');
});

test('standalone preview starts empty and the native bridge never fabricates a selected paper or formula', () => {
  const doc = fakeDocument();
  createFormulaPanelBridge({api: {}, doc, href: 'http://127.0.0.1:5079/sidepanel.html?preview=1'});
  assert.equal(selections(doc).length, 0);
  assert.equal(doc.nodes.get('previewBadge').hidden, false);
  assert.equal(doc.nodes.get('previewExample').hidden, false);
  doc.nodes.get('previewExample').click();
  assert.equal(selections(doc).length, 0);
  assert.equal(doc.nodes.get('selectedSource').href, undefined);
});
