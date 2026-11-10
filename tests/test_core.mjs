import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staticDir = path.join(project, 'static');
const coreSource = fs.readFileSync(path.join(staticDir, 'js/core.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export \{.*\};?\r?\n/gm, '').replace(/^export /gm, '');
const savedKey = 'easy-arxiv-web:saved:v1';
const selectedKey = 'easy-arxiv-web:selected:v1';
const plain = value => JSON.parse(JSON.stringify(value));
const paper = (overrides = {}) => ({
  id: '1706.03762', title: 'Attention Is All You Need',
  authors: ['Ashish Vaswani', 'Noam Shazeer'], published: '2017-06-12T17:57:34Z',
  summary: 'Attention connects positions.', category: 'cs.CL', ...overrides,
});

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key), values };
}
function loadCore({ local = storage(), session = storage() } = {}) {
  const context = vm.createContext({ URL, URLSearchParams, localStorage: local, sessionStorage: session, setTimeout, clearTimeout, listenToPaper(){}, listenToText(){}, stopSpeech(){}, openAudioSettings(){} });
  vm.runInContext(coreSource + '\nthis.api = {arxivId,pdfUrl,normalizePaper,escapeHTML,loadSaved,isSaved,toggleSaved,selectPaper,readSelectedPaper,readUrl,questUrl};', context);
  return context.api;
}

test('canonicalizes genuine modern, versioned and legacy arXiv identifiers', () => {
  const api = loadCore();
  const cases = [
    [' 1706.03762 ', '1706.03762'],
    ['arXiv:1706.03762v7', '1706.03762v7'],
    ['https://arxiv.org/abs/1706.03762v7?download=1#intro', '1706.03762v7'],
    ['https://www.arxiv.org/html/1706.03762v7', '1706.03762v7'],
    ['http://arxiv.org/pdf/1706.03762', '1706.03762'],
    ['https://export.arxiv.org/pdf/hep-th/9901001.pdf', 'hep-th/9901001'],
    ['https://arxiv.org:443/pdf/1706.03762/', '1706.03762'],
  ];
  for (const [input, id] of cases) {
    assert.equal(api.arxivId(input), id, input);
    assert.equal(api.pdfUrl(input), `https://arxiv.org/pdf/${id}`, input);
  }
});

test('rejects deceptive, credentialed and non-paper URLs', () => {
  const api = loadCore();
  const invalid = [
    'https://arxiv.org.evil.test/pdf/1706.03762', 'https://evil.test/arxiv.org/pdf/1706.03762',
    'https://arxiv.org@evil.test/pdf/1706.03762', 'https://user@arxiv.org/pdf/1706.03762',
    'https://user:secret@arxiv.org/pdf/1706.03762', 'https://arxiv.org:444/pdf/1706.03762',
    'javascript:alert(1)', 'data:text/html,test',
    '//arxiv.org/pdf/1706.03762', 'https://arxiv.org/pdf/not-a-paper',
    'https://arxiv.org/pdf/../../etc/passwd', 'https://arxiv.org/pdf/%31%37%30%36.03762',
    'https://arxiv.org/pdf/1706.03762%22%20onclick=alert(1)', '<img src=x onerror=alert(1)>',
    '', null, {}, 1706,
  ];
  for (const input of invalid) {
    assert.equal(api.arxivId(input), '', String(input));
    assert.equal(api.pdfUrl(input), '', String(input));
  }
});

test('normalizes supported metadata shapes while preserving versioned PDF and canonical paper identity', () => {
  const api = loadCore();
  const result = plain(api.normalizePaper({
    id: 'https://arxiv.org/abs/1706.03762v7', title: '  Attention\n Is   All You Need  ',
    abstract: '  A readable abstract.  ', authors: [{ name: 'Ashish Vaswani' }, 'Noam Shazeer', null],
    categories: ['cs.CL'], published: '2017-06-12', keywords: ['attention'],
  }));
  assert.equal(result.id, '1706.03762');
  assert.equal(result.pdf_url, 'https://arxiv.org/pdf/1706.03762v7');
  assert.equal(result.link, 'https://arxiv.org/abs/1706.03762v7');
  assert.equal(result.title, 'Attention Is All You Need');
  assert.equal(result.summary, 'A readable abstract.');
  assert.deepEqual(result.authors, ['Ashish Vaswani', 'Noam Shazeer']);
  assert.equal(result.category, 'cs.CL');
  assert.equal(result.summary_label, 'Abstract');
  assert.equal(api.normalizePaper(null), null);
  assert.equal(api.normalizePaper({ id: 'javascript:alert(1)' }), null);
  assert.equal(api.normalizePaper({ title: 'Missing paper identifier' }), null);
});

test('bounds stored metadata and escapes HTML separately from paper content', () => {
  const api = loadCore();
  const result = api.normalizePaper(paper({ title: 'x'.repeat(1200), summary: 'x'.repeat(41000), authors: ['x'.repeat(250)], category: 'x'.repeat(100), keywords: Array(12).fill('topic') }));
  assert.equal(result.title.length, 1000);
  assert.equal(result.summary.length, 40000);
  assert.equal(result.authors[0].length, 200);
  assert.equal(result.category.length, 80);
  assert.equal(result.keywords.length, 8);
  assert.equal(api.escapeHTML('<a title="x" onclick=\'x\'>A&B</a>'), '&lt;a title=&quot;x&quot; onclick=&#39;x&#39;&gt;A&amp;B&lt;/a&gt;');
});

test('encodes reader and Quest URL parameters without allowing extra query fields', () => {
  const api = loadCore();
  assert.equal(api.readUrl({ id: '1706.03762&admin=true' }), '/read?paper=1706.03762%26admin%3Dtrue');
  const title = 'What? A&B "quotes" <script> + α';
  const quest = new URL(api.questUrl(paper({ title })), 'https://example.test');
  assert.equal(quest.pathname, '/quest');
  assert.equal(quest.searchParams.get('pdf'), 'https://arxiv.org/pdf/1706.03762');
  assert.equal(quest.searchParams.get('title'), title);
  assert.equal([...quest.searchParams].length, 2);
  assert.equal(api.questUrl({ id: 'javascript:alert(1)' }), '/quest');
});

test('guest saved cache ignores legacy browser bookmarks rather than migrating without an account', async () => {
  const local = storage({ [savedKey]: JSON.stringify([paper(), paper({ id: '2006.11239' })]) });
  const api = loadCore({ local });
  assert.deepEqual(plain(api.loadSaved()), []);
  assert.equal(api.isSaved('1706.03762'), false);
  assert.equal(await api.toggleSaved(paper()), false);
  assert.equal(JSON.parse(local.getItem(savedKey)).length, 2, 'legacy data is ignored, never silently moved into an account');
});

test('paper selection is normalized and available with session storage blocked', () => {
  const session = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const api = loadCore({ session });
  api.selectPaper(paper({ id: '1706.03762v7' }));
  assert.equal(api.readSelectedPaper().id, '1706.03762');
  assert.equal(api.readSelectedPaper().pdf_url, 'https://arxiv.org/pdf/1706.03762v7');
  const persisted = storage();
  loadCore({ session: persisted }).selectPaper(paper());
  assert.equal(JSON.parse(persisted.getItem(selectedKey)).id, '1706.03762');
});

test('every local HTML and CSS asset reference exists and every template has accessible landmarks', () => {
  const templates = fs.readdirSync(staticDir).filter(name => name.endsWith('.html'));
  for (const name of templates) {
    const source = fs.readFileSync(path.join(staticDir, name), 'utf8');
    assert.match(source, /<html\b[^>]*\blang="en"/i, `${name}: document language`);
    assert.match(source, /<meta\b[^>]*name="viewport"/i, `${name}: responsive viewport`);
    const mainId = source.match(/<main\b[^>]*\bid="([^" ]+)"/i)?.[1];
    assert.ok(mainId, `${name}: main landmark`);
    const skipTarget = source.match(/class="skip-link"[^>]*href="#([^" ]+)"/i)?.[1];
    assert.equal(skipTarget, mainId, `${name}: skip navigation reaches main`);
    assert.doesNotMatch(source, /laboratory/i, `${name}: Laboratory excluded`);
    for (const [, asset] of source.matchAll(/\b(?:src|href)="(\/static\/[^"?#]+)(?:[?#][^"]*)?"/g)) {
      assert.ok(fs.existsSync(path.join(project, decodeURIComponent(asset))), `${name}: missing ${asset}`);
    }
    for (const [tag] of source.matchAll(/<a\b[^>]*\btarget="_blank"[^>]*>/g)) {
      assert.match(tag, /\brel="[^"]*noopener/, `${name}: safe new-tab link`);
    }
  }
  const css = fs.readFileSync(path.join(staticDir, 'css/app.css'), 'utf8');
  for (const [, asset] of css.matchAll(/url\(['"]?(\/static\/[^)'"?#]+)(?:[?#][^)'"\s]*)?['"]?\)/g)) {
    assert.ok(fs.existsSync(path.join(project, decodeURIComponent(asset))), `CSS: missing ${asset}`);
  }
  for (const module of ['app.js', 'quest.js', 'hero.js', 'search-ui.js', 'core.js']) {
    const source = fs.readFileSync(path.join(staticDir, 'js', module), 'utf8');
    for (const [, relative] of source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
      assert.ok(fs.existsSync(path.resolve(staticDir, 'js', relative.split(/[?#]/)[0])), `${module}: missing import ${relative}`);
    }
  }
});

test('home carousel starts with one visible slide and keeps other slides out of keyboard focus', () => {
  const source = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8');
  const slides = [...source.matchAll(/<section\b[^>]*\bdata-slide="\d+"[^>]*>/g)].map(match => match[0]);
  assert.equal(slides.length, 3);
  assert.equal(slides.filter(tag => !/\bhidden\b/.test(tag)).length, 1);
  for (const slide of slides.filter(tag => /\bhidden\b/.test(tag))) {
    assert.match(slide, /\binert\b/);
    assert.match(slide, /aria-hidden="true"/);
  }
  assert.doesNotMatch(source, /class="[^"]*(?:carousel-dots|carousel-arrows|slide-counter)/, 'requested carousel controls stay absent');
});
