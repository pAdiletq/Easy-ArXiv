import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'static/js/hero.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const context = vm.createContext({ escapeHTML });
vm.runInContext(source + '\nthis.api={percentageChange,prepareMonthlySeries,comparisonText,shouldAdvanceHero,chartSvg};', context);
const api = context.api;
const plain = value => JSON.parse(JSON.stringify(value));

test('monthly change uses the previous month as denominator and handles zero honestly', () => {
  assert.equal(api.percentageChange(150, 100), 50);
  assert.equal(api.percentageChange(75, 100), -25);
  assert.equal(api.percentageChange(0, 100), -100);
  assert.equal(api.percentageChange(100, 0), null);
  assert.equal(api.percentageChange(0, 0), null);
  assert.equal(api.percentageChange(NaN, 100), null);
  assert.equal(api.percentageChange(50, -100), null);
});

test('chart displays the latest nine genuine months and retains the previous comparison before the window', () => {
  const months = Array.from({ length: 11 }, (_, index) => ({ period: `2026-${String(index + 1).padStart(2, '0')}`, label: `Month ${index + 1}`, value: (index + 1) * 100 }));
  const series = plain(api.prepareMonthlySeries(months));
  assert.equal(series.length, 9);
  assert.equal(series[0].period, '2026-03');
  assert.equal(series[0].previousValue, 200);
  assert.equal(series[0].change, 50);
  assert.equal(series.at(-1).value, 1100);
});

test('invalid or missing months cannot create a false month-on-month comparison', () => {
  const series = plain(api.prepareMonthlySeries([
    { period: '2025-12', label: 'Dec', value: 100 },
    { period: '2026-01', label: 'Jan', value: 125 },
    { period: '2026-02', label: 'Feb', value: -5 },
    { period: '2026-03', label: 'Mar', value: 150 },
    { period: '2026-04', label: 'Apr', value: '200' },
    { period: '2026-05', label: 'May', value: Infinity },
    null,
  ]));
  assert.equal(series.length, 3);
  assert.equal(series[1].change, 25, 'December to January crosses a year correctly');
  assert.equal(series[2].previousValue, null, 'March cannot be compared with January as a monthly change');
  assert.equal(series[2].change, null);
  assert.deepEqual(plain(api.prepareMonthlySeries({ value: 50 })), []);
});

test('tooltip comparisons distinguish increase, decrease, equal values and absent baseline', () => {
  assert.equal(api.comparisonText({ change: 12.34, previousLabel: 'Jun' }), '+12.3% vs Jun');
  assert.equal(api.comparisonText({ change: -10, previousLabel: 'Jun' }), '−10.0% vs Jun');
  assert.equal(api.comparisonText({ change: 0, previousLabel: 'Jun' }), '0.0% vs Jun');
  assert.match(api.comparisonText({ change: null, previousValue: null }), /outside this view/);
  assert.match(api.comparisonText({ change: null, previousValue: 0 }), /had no submissions/);
});

test('every interaction, visibility and motion pause condition blocks automatic advancement', () => {
  const state = { documentHidden: false, offscreen: false, reducedMotion: false, hovered: false, focused: false, transitioning: false, listening: false };
  assert.equal(api.shouldAdvanceHero(state), true);
  for (const condition of Object.keys(state)) assert.equal(api.shouldAdvanceHero({ ...state, [condition]: true }), false, condition);
});

test('chart columns include full keyboard-readable counts and escaped provider labels', () => {
  const series = api.prepareMonthlySeries([
    { value: 20000, period: '2026-08', label: 'Aug' },
    { value: 25000, period: '2026-09', label: '<img src=x>' },
  ]);
  const svg = api.chartSvg(series, 'A "quoted" period <script>');
  assert.equal((svg.match(/tabindex="0"/g) || []).length, 2);
  assert.match(svg, /September 2026: 25,000 papers\. \+25\.0% vs Aug/);
  assert.match(svg, /role="group"/);
  assert.match(svg, /&lt;img src=x&gt;/);
  assert.match(svg, /&quot;quoted&quot;/);
  assert.ok(!svg.includes('<script>'));
  assert.ok(!svg.includes('<img'));
  const bars = [...svg.matchAll(/<rect class="chart-bar"[^>]* y="([\d.]+)"[^>]* height="([\d.]+)"/g)];
  assert.equal(bars.length, 2);
  bars.forEach(match => assert.ok(Math.abs(Number(match[1]) + Number(match[2]) - 277) < .001, 'all bars share the same zero baseline'));
});

test('zero-valued archives produce finite chart dimensions without invented data', () => {
  const svg = api.chartSvg(api.prepareMonthlySeries([{ value: 0, period: '2026-09', label: 'Sep' }]), 'Sep 2026');
  assert.ok(!/NaN|Infinity/.test(svg));
  assert.match(svg, /height="0"/);
  assert.match(svg, /0 papers/);
});
