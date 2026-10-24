import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createPaperController} from '../extensions/formula-lens/paper-controller.js';
import {pdfSource} from '../extensions/formula-lens/selection.js';

const firstURL = 'https://papers.example.test/report.pdf?document=A#page=1';
const secondURL = 'https://papers.example.test/report.pdf?document=B#page=1';
const raw = 'F(x) = A*x^2 + a';
const connection = accessToken => ({accessToken, expiresAt: Date.now() + 1200000});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
async function settle() {for (let count = 0; count < 30; count++) await Promise.resolve();}
function event() {
  const callbacks = [];
  return {addListener: callback => callbacks.push(callback), emit: (...values) => {
    for (const callback of callbacks) callback(...values);
  }};
}
class Element {
  constructor() {
    this.hidden = false; this.disabled = false; this.value = ''; this.textContent = ''; this.children = []; this.style = {}; this.listeners = new Map(); this.attributes = new Map();
    const classes = new Set();
    this.classList = {add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name)};
  }
  addEventListener(name, callback) {const list = this.listeners.get(name) || []; list.push(callback); this.listeners.set(name, list);}
  async fire(name) {return Promise.all((this.listeners.get(name) || []).map(callback => callback({preventDefault() {}})));}
  click() {return this.fire('click');}
  append(...nodes) {this.children.push(...nodes);}
  prepend(...nodes) {this.children.unshift(...nodes);}
  replaceChildren(...nodes) {this.children = nodes;}
  setAttribute(key, value) {this.attributes.set(key, String(value));}
  removeAttribute(key) {this.attributes.delete(key); if (key === 'href') delete this.href;}
  focus() {}
}
function harness(t) {
  const nodes = new Map(), listeners = new Map(), calls = [], reads = [], disconnects = [];
  const node = id => {if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id);};
  const doc = {getElementById: node, querySelector: selector => node(selector), querySelectorAll: () => [],
    createElement: () => new Element(), createElementNS: () => new Element(), createTextNode: value => ({textContent: value}),
    addEventListener: (name, callback) => {const list = listeners.get(name) || []; list.push(callback); listeners.set(name, list);},
    dispatchEvent: value => {for (const callback of listeners.get(value.type) || []) callback(value); return true;}};
  const h = {nodes, node, doc, calls, reads, disconnects, active: {tabId: 7, source: pdfSource(firstURL)}, controller: null};
  h.connect = async () => connection('synthetic-connection-A');
  h.disconnect = async () => {disconnects.push(true);};
  h.request = async (path, body) => ({data: path.endsWith('/papers')
    ? {contextId: 'synthetic-context-' + h.active.source.originalUrl, paper: {title: 'Analyzed ' + h.active.source.originalUrl}}
    : {status: 'needs_context', limitations: ['Synthetic context needs correction.']}});
  const api = {runtime: {id: 'a'.repeat(32), sendMessage: async message => {
    if (message.type === 'formula/paper-source') return h.active ? {ok: true, data: h.active} : {ok: false, error: 'Return to the original PDF.'};
    if (message.type === 'formula/read-paper') {
      reads.push(structuredClone(message));
      if (!h.active || message.expectedOriginalURL !== h.active.source.originalUrl || message.expectedTabId !== h.active.tabId || message.sourceId !== h.active.source.sourceId) {
        return {ok: false, error: 'The original paper tab changed.'};
      }
      return {ok: true, data: {pdfBase64: 'synthetic-pdf-input', source: {sourceId: h.active.source.sourceId, label: h.active.source.label}}};
    }
    throw Error('Unreviewed test message');
  }}, tabs: {onActivated: event(), onUpdated: event()}};
  const service = {connect: options => h.connect(options), disconnect: (...args) => h.disconnect(...args),
    request: async (...args) => {calls.push(args); return h.request(...args);}};
  const sandbox = {document: doc, chrome: api, location: {href: 'chrome-extension://' + 'a'.repeat(32) + '/sidepanel.html'},
    window: {addEventListener() {}}, URL, AbortController, CustomEvent, setTimeout, clearTimeout,
    prepareExpression: text => ({expression: text, warnings: []}),
    compileFormula: () => ({ast: {type: 'symbol', name: 'x'}, assignment: 'f(x)'}),
    createPaperController: options => {h.controller = createPaperController({...options, doc, api,
      href: 'chrome-extension://' + 'a'.repeat(32) + '/sidepanel.html', service}); return h.controller;}};
  // Run the actual panel listeners against the real, dependency-injected
  // controller. Rendering/math are inert stand-ins; no DOM/browser/network is used.
  const panel = readFileSync(new URL('../extensions/formula-lens/panel.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/gm, '');
  vm.runInNewContext(panel, sandbox);
  h.select = (text = raw, source = h.active.source) => doc.dispatchEvent(new CustomEvent('formula-selection', {detail: {rawText: text, source}}));
  h.clear = () => doc.dispatchEvent(new CustomEvent('formula-clear'));
  h.analyze = () => node('analyzePaper').fire('click');
  t.after(() => h.controller.dispose());
  return h;
}

test('pairing-tab clear and duplicate restored selection do not cancel the article analysis the user started', async t => {
  const h = harness(t), pairing = deferred(); t.after(() => pairing.resolve(connection('synthetic-connection-A')));
  await settle(); h.select();
  h.connect = () => pairing.promise;
  const analyzing = h.analyze(); await settle();
  assert.equal(h.controller.isWorking(), true);
  h.clear(); h.select(); await settle();
  assert.equal(h.controller.isWorking(), true);
  pairing.resolve(connection('synthetic-connection-A')); await analyzing; await settle();
  assert.equal(h.calls.filter(([path]) => path.endsWith('/papers')).length, 1);
  assert.equal(h.node('paperTitle').textContent, 'Analyzed ' + firstURL);
});

test('a current-PDF clear with no selected formula does not cancel a valid article analysis', async t => {
  const h = harness(t), response = deferred(); t.after(() => response.resolve({data: {contextId: 'synthetic-context', paper: {title: 'Paper analyzed'}}}));
  await settle(); h.request = () => response.promise;
  const analyzing = h.analyze(); await settle();
  h.clear(); await settle(); assert.equal(h.controller.isWorking(), true);
  response.resolve({data: {contextId: 'synthetic-context', paper: {title: 'Paper analyzed'}}});
  await analyzing; assert.equal(h.node('paperTitle').textContent, 'Paper analyzed');
});

test('downloads bind to the captured tab and exact signed URL, including query document identity', async t => {
  const h = harness(t), pairing = deferred(); t.after(() => pairing.resolve(connection('synthetic-connection-A')));
  await settle(); h.connect = () => pairing.promise;
  const analyzing = h.analyze(); await settle();
  h.active = {tabId: 7, source: pdfSource(secondURL)};
  pairing.resolve(connection('synthetic-connection-A')); await analyzing;
  assert.equal(h.reads[0].expectedOriginalURL, firstURL);
  assert.equal(h.reads[0].expectedTabId, 7);
  assert.equal(h.calls.length, 0);
  assert.notEqual(h.node('paperTitle').textContent, 'Analyzed ' + firstURL);
});

test('a stale pairing completion cannot clear a newer article context', async t => {
  const h = harness(t), old = deferred(); t.after(() => old.resolve(connection('synthetic-connection-old')));
  await settle(); h.select();
  let connections = 0; h.connect = () => ++connections === 1 ? old.promise : Promise.resolve(connection('synthetic-connection-new'));
  const first = h.analyze(); await settle();
  h.active = {tabId: 8, source: pdfSource(secondURL)}; h.select('y = sin(x)');
  await h.analyze();
  old.resolve(connection('synthetic-connection-old')); await first;
  await h.controller.explain('y = sin(x)');
  const explanations = h.calls.filter(([path]) => path.endsWith('/explain'));
  assert.equal(explanations.length, 1);
  assert.equal(explanations[0][2].accessToken, 'synthetic-connection-new');
});

test('an old pairing finishing cannot remove the newer pairing navigation guard', async t => {
  const h = harness(t), old = deferred(), next = deferred();
  t.after(() => {old.resolve(connection('synthetic-connection-old')); next.resolve(connection('synthetic-connection-new'));});
  await settle(); h.select();
  let connections = 0; h.connect = () => ++connections === 1 ? old.promise : next.promise;
  const first = h.analyze(); await settle();
  h.active = {tabId: 8, source: pdfSource(secondURL)}; h.select('y = sin(x)');
  const second = h.analyze(); await settle();
  old.resolve(connection('synthetic-connection-old')); await first;
  const pdf = h.active; h.active = null; h.clear(); await settle();
  assert.equal(h.controller.isWorking(), true);
  h.active = pdf; next.resolve(connection('synthetic-connection-new')); await second;
  assert.equal(h.node('paperTitle').textContent, 'Analyzed ' + secondURL);
});

test('a delayed401 from a previous job cannot disconnect a newer article context', async t => {
  const h = harness(t), old = deferred(); t.after(() => old.resolve({data: {contextId: 'unused', paper: {title: 'Unused'}}}));
  await settle(); h.select();
  let requests = 0; const standard = h.request;
  h.request = (...args) => ++requests === 1 ? old.promise : standard(...args);
  const first = h.analyze(); await settle();
  h.active = {tabId: 8, source: pdfSource(secondURL)}; h.select('y = sin(x)'); await h.analyze();
  const error = Error('Synthetic expired grant'); error.status = 401; old.reject(error); await first;
  assert.equal(h.disconnects.length, 0);
  await h.controller.explain('y = sin(x)');
  assert.equal(h.calls.filter(([path]) => path.endsWith('/explain')).length, 1);
});

test('a provider response arriving after a PDF/tab change is never shown as a completed analysis', async t => {
  const h = harness(t), old = deferred(); t.after(() => old.resolve({data: {contextId: 'unused', paper: {title: 'Wrong paper'}}}));
  await settle(); h.request = () => old.promise;
  const analyzing = h.analyze(); await settle();
  h.active = {tabId: 9, source: pdfSource(secondURL)};
  old.resolve({data: {contextId: 'synthetic-wrong-context', paper: {title: 'Wrong paper'}}}); await analyzing;
  assert.notEqual(h.node('paperTitle').textContent, 'Wrong paper');
  assert.notEqual(h.node('paperStatus').textContent, 'Paper context is ready. Select a formula in the PDF, then explain it.');
});
