const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../static/js/quest.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const context = vm.createContext({ URL });
vm.runInContext(source + '\nthis.api = { normalizeCards, normalizeQuestions, safePdf, summarizeAnswers, restoreProgress, contentSignature };', context);
const api = context.api;
const plain = value => JSON.parse(JSON.stringify(value));
const sampleQuestion = { question: 'What is combined?', options: ['Keys', 'Queries', 'Weighted values', 'Counts'], answer: 2, explanation: 'Weights are applied to values.' };

test('normalizes nested provider cards, ignoring incomplete or ambiguous content', () => {
  const result = api.normalizeCards({ flashcards: { flashcards: [{ 'Attention': 'Connect positions.' }, { topic: 'Order', content: 'Use positional signals.' }, { title: 'Heads', content: 'Different projections.' }, { title: 'Empty', content: '' }, { topic: 'Missing content' }, { title: 'Missing content' }, { first: 'a', second: 'b' }, null] } });
  assert.deepEqual(plain(result), [{ title: 'Attention', content: 'Connect positions.' }, { title: 'Order', content: 'Use positional signals.' }, { title: 'Heads', content: 'Different projections.' }]);
});

test('normalizes keyed questions and rejects malformed choices or answer indices', () => {
  const result = api.normalizeQuestions({ questions: { q1: sampleQuestion, q2: { ...sampleQuestion, answer: 'C' }, q3: { ...sampleQuestion, answer: 'Weighted values' }, q4: { ...sampleQuestion, options: ['A', 'a', 'C', 'D'] }, q5: { ...sampleQuestion, answer: 4 }, q6: { ...sampleQuestion, answer: true }, q7: { ...sampleQuestion, options: ['A', 'B'] } } });
  assert.equal(result.length, 3);
  assert.ok(result.every(question => question.answer === 2));
});

test('accepts actual modern and legacy arXiv URLs and rejects unrelated or deceptive URLs', () => {
  assert.equal(api.safePdf('https://arxiv.org/abs/1706.03762v7?x=1#intro'), 'https://arxiv.org/pdf/1706.03762v7');
  assert.equal(api.safePdf('https://export.arxiv.org/pdf/hep-th/9901001.pdf'), 'https://arxiv.org/pdf/hep-th/9901001');
  ['https://arxiv.org.evil.test/pdf/1706.03762', 'http://arxiv.org/pdf/1706.03762', 'https://user@arxiv.org/pdf/1706.03762', 'https://arxiv.org:444/pdf/1706.03762', 'https://arxiv.org/pdf/../test', 'javascript:alert(1)', 'https://arxiv.org/pdf/not-a-paper'].forEach(url => assert.equal(api.safePdf(url), ''));
});

test('restores only valid answers and indices for the exact current study content', () => {
  const cards = [{ title: 'A', content: 'First idea' }, { title: 'B', content: 'Second idea' }];
  const questions = [sampleQuestion, sampleQuestion];
  const saved = { signature: api.contentSignature(cards, questions), activeIdea: 1, activeQuestion: 99, answers: { 0: 2, 1: -1, 99: 1 }, visited: [0, 1, 1, -1, 20, '1'], tab: 'quiz' };
  const restored = api.restoreProgress(saved, cards, questions);
  assert.deepEqual(plain(restored), { activeIdea: 1, activeQuestion: 0, answers: { 0: 2 }, visited: [0, 1], tab: 'quiz' });
  assert.deepEqual(plain(api.restoreProgress(saved, [{ title: 'Changed', content: 'New content' }], questions)), { activeIdea: 0, activeQuestion: 0, answers: {}, visited: [0], tab: 'ideas' });
});

test('score counts checked valid answers only, including answer zero', () => {
  const questions = [{ ...sampleQuestion, answer: 0 }, sampleQuestion, sampleQuestion];
  assert.deepEqual(plain(api.summarizeAnswers(questions, { 0: 0, 1: 1, 2: 8 })), { answered: 2, correct: 1, total: 3 });
});

test('fresh sessions select the available mode and invalid saved answers stay unselected', () => {
  const questions = [sampleQuestion];
  assert.deepEqual(plain(api.restoreProgress(null, [], questions)), { activeIdea: 0, activeQuestion: 0, answers: {}, visited: [], tab: 'quiz' });
  const cards = [{ title: 'Attention', content: 'An idea.' }];
  const saved = { signature: api.contentSignature(cards, questions), answers: { 0: '2' }, tab: 'invalid' };
  const progress = api.restoreProgress(saved, cards, questions);
  assert.equal(progress.tab, 'ideas');
  assert.deepEqual(plain(progress.answers), {});
  assert.equal(api.normalizeQuestions([{ ...sampleQuestion, options: ['a'.repeat(4000) + 'b', 'a'.repeat(4000) + 'c', 'c', 'd'] }]).length, 0);
});

test('prepared learning example has nine valid ideas and questions and stays clearly labeled', () => {
  const papersContext = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js/papers.js'), 'utf8'), papersContext);
  const example = papersContext.window.EasyArxivPapers.attentionQuest;
  assert.equal(example.demo, true);
  assert.match(example.label, /prepared/i);
  assert.equal(api.normalizeCards(example.flashcards).length, 9);
  assert.equal(api.normalizeQuestions(example.questions).length, 9);
});

test('401 presents an ORCID action, keeps the guest example available, and does not retry paid generation', async () => {
  class Element {
    constructor() { this.listeners = {}; this.hidden = false; this.textContent = ''; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    setAttribute() {}
    replaceChildren() {}
    append() {}
  }
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const navigations = [];
  let requests = 0;
  const ui = vm.createContext({
    URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    mountShell() {}, readSelectedPaper: () => null, stopSharedSpeech() {},
    location: {search: '?pdf=https%3A%2F%2Farxiv.org%2Fpdf%2F1706.03762'},
    sessionStorage: {getItem: () => null},
    document: {getElementById: element, createElement: () => new Element(), addEventListener() {}},
    window: {addEventListener() {}, EasyArxivPapers: {attentionQuest: {}}, location: {assign: url => navigations.push(url)}},
    fetch: async () => { requests++; return {ok: false, status: 401, json: async () => ({detail: 'Authentication required'})}; },
  });
  vm.runInContext(source, ui);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1);
  assert.equal(element('stateTitle').textContent, 'Sign in to generate AI Quest.');
  assert.match(element('stateDescription').textContent, /prepared example without signing in/);
  assert.equal(element('retryButton').textContent, 'Continue with ORCID');
  assert.equal(element('retryButton').hidden, false);
  assert.equal(element('exampleButton').hidden, false);
  element('retryButton').listeners.click();
  assert.deepEqual(navigations, ['/auth/login']);
  assert.equal(requests, 1);
});
