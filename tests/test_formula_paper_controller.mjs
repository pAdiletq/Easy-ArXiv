import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createPaperController} from '../extensions/formula-lens/paper-controller.js';
import {pdfSource} from '../extensions/formula-lens/selection.js';
import {prepareExpression,compileFormula,evaluateFormula} from '../extensions/formula-lens/formula-engine.js';
import {createMotion} from '../extensions/formula-lens/motion.js';

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
  constructor(tagName='div') {
    this.tagName=tagName.toUpperCase();this.dataset={};
    this.hidden = false; this.disabled = false; this.value = ''; this.textContent = ''; this.children = []; this.style = {}; this.listeners = new Map(); this.attributes = new Map();
    const classes = new Set();
    this.classList = {add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name),
      toggle(name,force){const include=force===undefined?!classes.has(name):force;if(include)classes.add(name);else classes.delete(name);return include;}};
  }
  addEventListener(name, callback) {const list = this.listeners.get(name) || []; list.push(callback); this.listeners.set(name, list);}
  async fire(name) {return Promise.all((this.listeners.get(name) || []).map(callback => callback({preventDefault() {}})));}
  click() {return this.fire('click');}
  append(...nodes) {this.children.push(...nodes);}
  prepend(...nodes) {this.children.unshift(...nodes);}
  replaceChildren(...nodes) {this.children = nodes;}
  setAttribute(key, value) {this.attributes.set(key, String(value));}
  removeAttribute(key) {this.attributes.delete(key); if (key === 'href') delete this.href;}
  get rows(){return this.children.filter(node=>node.tagName==='TR');}
  get cells(){return this.children.filter(node=>node.tagName==='TD'||node.tagName==='TH');}
  querySelector(selector){
    for(const child of this.children){
      if(selector==='table[data-result]'&&child.tagName==='TABLE'&&child.dataset.result!==undefined)return child;
      const match=child.querySelector?.(selector);if(match)return match;
    }
    return null;
  }
  querySelectorAll(){return [];}
  focus() {}
}
function harness(t,{preview=false}={}) {
  const nodes = new Map(), listeners = new Map(), calls = [], reads = [], disconnects = [];
  const node = id => {if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id);};
  const doc = {getElementById: node, querySelector: selector => node(selector), querySelectorAll: () => [],
    createElement: tag => new Element(tag), createElementNS: (_namespace,tag) => new Element(tag), createTextNode: value => ({textContent: value}),
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
  const href=preview?'http://127.0.0.1:5079/sidepanel.html?preview=1':'chrome-extension://' + 'a'.repeat(32) + '/sidepanel.html';
  const sandbox = {document: doc, chrome: api, location: {href},
    window: {addEventListener() {},matchMedia:()=>({matches:true,addEventListener(){}})}, URL, AbortController, CustomEvent, setTimeout, clearTimeout,structuredClone,
    prepareExpression,compileFormula,evaluateFormula,createMotion:()=>createMotion({reducedMotion:true}),
    createPaperController: options => {h.controller = createPaperController({...options, doc, api,
      href, service}); return h.controller;}};
  // Run the actual panel listeners against the real, dependency-injected
  // controller. Math is real; motion completes instantly under reduced motion.
  // DOM elements are bounded stand-ins; no browser or network is used.
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

test('the installed-extension worked example is explicitly local and cannot analyze or explain a real PDF', async t => {
  const h = harness(t);let connections=0;h.connect=async()=>{connections++;return connection('unused-sample-connection');};await settle();
  await h.node('usageExample').fire('click');
  assert.equal(h.controller.isSample(), true);
  assert.equal(h.node('paperTitle').textContent, 'LoRA: Low-Rank Adaptation');
  assert.match(h.node('usageExampleNote').textContent, /toy values.*no AI request/);
  assert.equal(h.node('usageExampleNote').hidden, false);
  assert.equal(h.node('analyzePaper').disabled, true);
  assert.equal(h.node('analyzeFormula').disabled, true);
  assert.match(h.node('rawSelection').textContent, /strength\*matmul\(B, A\)/);
  await h.analyze(); await h.controller.explain(raw);
  assert.equal(h.calls.length, 0);
  assert.equal(h.reads.length, 0);
  assert.equal(connections, 0);
  assert.equal(h.node('paperFormulaView').hidden, false);
});

test('the sample strength changes the matrix and reduced-motion playback finishes at the correct result', async t => {
  const h=harness(t);await settle();h.controller.openUsageExample();
  const result=()=>h.node('matrixView').querySelector('table[data-result]').rows.map(row=>row.cells.map(cell=>cell.textContent));
  assert.deepEqual(result(),[['1.1','0'],['0.2','1']]);
  h.node('exampleStrength').value='0';await h.node('exampleStrength').fire('input');
  assert.deepEqual(result(),[['1','0'],['0','1']]);
  assert.match(h.node('exampleResult').textContent,/Original weights recovered/);
  await h.node('playExample').fire('click');
  assert.deepEqual(result(),[['1.1','0'],['0.2','1']]);
  assert.equal(h.node('exampleStrength').value,'1');
  assert.equal(h.node('playExample').attributes.get('aria-pressed'),'false');
  assert.equal(h.node('playExample').textContent,'Replay update');
  assert.equal(h.calls.length,0);assert.equal(h.reads.length,0);
});

test('the local preview uses the same usage-example button without a legacy preview action or an AI request', async t => {
  const h=harness(t,{preview:true});await settle();
  assert.equal(h.node('previewBadge').hidden,false);
  assert.equal(h.node('paperTitle').textContent,'Interface preview');
  assert.equal(h.nodes.has('previewExample'),false);
  await h.node('usageExample').fire('click');
  assert.equal(h.controller.isSample(),true);
  assert.equal(h.node('paperTitle').textContent,'LoRA: Low-Rank Adaptation');
  await h.analyze();await h.controller.explain(raw);
  assert.equal(h.calls.length,0);assert.equal(h.reads.length,0);
  h.controller.clear();await settle();
  assert.equal(h.controller.isSample(),false);
  assert.equal(h.node('paperTitle').textContent,'Interface preview');
  assert.equal(h.node('analyzePaper').disabled,true);
});

test('opening the sample repeatedly keeps the original PDF as the return source', async t => {
  const h = harness(t); await settle();
  h.controller.openUsageExample();h.controller.openUsageExample();h.controller.clear();await settle();
  assert.equal(h.node('paperSource').href, firstURL);
  assert.equal(h.controller.isSample(), false);
  assert.equal(h.calls.length, 0);
});

test('leaving the sample restores the actual PDF and never carries sample context into a real explanation', async t => {
  const h = harness(t); await settle();
  await h.analyze(); assert.equal(h.calls.length, 1);
  h.controller.openUsageExample(); h.controller.clear(); await settle();
  assert.equal(h.controller.isSample(), false);
  assert.equal(h.node('usageExampleNote').hidden, true);
  assert.equal(h.node('paperSource').href, firstURL);
  assert.equal(h.node('paperTitle').textContent, 'Start with the paper.');
  await h.controller.explain(raw);
  assert.equal(h.calls.length, 1);
  assert.match(h.node('formulaIssue').textContent, /Analyze this paper first/);
  await h.analyze(); await h.controller.explain(raw);
  assert.equal(h.calls.filter(([path]) => path.endsWith('/papers')).length, 2);
  assert.equal(h.calls.filter(([path]) => path.endsWith('/explain')).length, 1);
});

test('a pending paper analysis is cancelled by the sample and a late response cannot overwrite it', async t => {
  const h = harness(t), old = deferred();
  t.after(() => old.resolve({data: {contextId: 'unused', paper: {title: 'Late real analysis'}}}));
  await settle(); h.request = () => old.promise;
  const analyzing = h.analyze(); await settle();
  const signal = h.calls[0][2].signal;
  assert.equal(h.controller.isWorking(), true);
  h.controller.openUsageExample();
  assert.equal(signal.aborted, true);
  assert.equal(h.controller.isWorking(), false);
  old.resolve({data: {contextId: 'stale-context', paper: {title: 'Late real analysis'}}});
  await analyzing;
  assert.equal(h.controller.isSample(), true);
  assert.equal(h.node('paperTitle').textContent, 'LoRA: Low-Rank Adaptation');
  assert.equal(h.node('paperStatus').textContent, 'Worked example · illustrative values');
  assert.equal(h.calls.length, 1);
});

test('a real selection from the sample article still requires its own analysis', async t => {
  const h = harness(t); await settle(); h.controller.openUsageExample();
  h.active = {tabId: 9, source: pdfSource('https://arxiv.org/pdf/2106.09685')};
  h.select('W = W_0 + matmul(B, A)');
  assert.equal(h.controller.isSample(), false);
  assert.equal(h.node('usageExampleNote').hidden, true);
  assert.equal(h.node('paperTitle').textContent, 'Start with the paper.');
  await h.controller.explain(raw);
  assert.equal(h.calls.length, 0);
  assert.equal(h.reads.length, 0);
});

test('refresh keeps a sample on its original tab but exits it when the actual PDF changes', async t => {
  const h = harness(t); await settle(); h.controller.openUsageExample();
  await h.controller.refresh();
  assert.equal(h.controller.isSample(), true);
  h.active = {tabId: 8, source: pdfSource(secondURL)};
  await h.controller.refresh();
  assert.equal(h.controller.isSample(), false);
  assert.equal(h.node('paperSource').href, secondURL);
  assert.equal(h.node('paperFormulaView').hidden, true);
  await h.controller.explain(raw);
  assert.equal(h.calls.length, 0);
});

test('a sample opened without a PDF survives unrelated refresh failures and remains entirely local', async t => {
  const h=harness(t);await settle();h.active=null;await h.controller.refresh();
  h.controller.openUsageExample();await h.controller.refresh();
  h.active=null;await h.controller.refresh();
  assert.equal(h.controller.isSample(),true);
  assert.equal(h.node('paperTitle').textContent,'LoRA: Low-Rank Adaptation');
  assert.equal(h.node('paperFormulaView').hidden,false);
  await h.analyze();await h.controller.explain(raw);
  assert.equal(h.calls.length,0);assert.equal(h.reads.length,0);
});

test('losing the original PDF exits a sample that was opened from that PDF', async t => {
  const h=harness(t);await settle();h.controller.openUsageExample();
  h.active=null;await h.controller.refresh();
  assert.equal(h.controller.isSample(),false);
  assert.equal(h.node('usageExampleNote').hidden,true);
  assert.equal(h.node('paperFormulaView').hidden,true);
  assert.equal(h.node('paperSource').hidden,true);
  assert.equal(h.calls.length,0);
});
