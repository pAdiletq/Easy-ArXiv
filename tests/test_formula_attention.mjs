import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAttention, createAttentionExample, ATTENTION_DIMENSION } from '../extensions/formula-lens/attention.js';

const close = (actual, expected, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `Expected ${actual} to be within ${tolerance} of ${expected}`);
const allFinite = value => Array.isArray(value) ? value.every(allFinite) : Number.isFinite(value);

test('uniform attention averages the values and has the expected matrix dimensions', () => {
  const result = computeAttention({ Q: [[0, 0], [0, 0]], K: [[1, 2], [3, 4]], V: [[1, 3], [3, 1]] });
  assert.equal(result.d_k, 2);
  assert.equal(ATTENTION_DIMENSION, 2);
  assert.deepEqual(result.rawDotProducts, [[0, 0], [0, 0]]);
  assert.deepEqual(result.weights, [[0.5, 0.5], [0.5, 0.5]]);
  assert.deepEqual(result.output, [[2, 2], [2, 2]]);
});

test('nonuniform attention computes the original scale and a known weighted output', () => {
  const result = computeAttention({ Q: [[Math.sqrt(2), 0]], K: [[0, 0], [1, 0]], V: [[0, 2], [4, 0]] });
  const probability = Math.E / (1 + Math.E);
  close(result.rawDotProducts[0][1], Math.sqrt(2));
  close(result.scaledScores[0][1], 1);
  assert.deepEqual(result.scores, result.scaledScores);
  close(result.weights[0][1], probability);
  close(result.output[0][0], 4 * probability);
  close(result.output[0][1], 2 * (1 - probability));
});

test('temperature is a separate experiment and never changes d_k or original scaled scores', () => {
  const example = { Q: [[Math.sqrt(2), 0]], K: [[0, 0], [1, 0]], V: [[0, 2], [4, 0]] };
  const original = computeAttention(example), warmer = computeAttention({ ...example, temperature: 2 });
  assert.equal(warmer.d_k, 2);
  assert.deepEqual(warmer.scaledScores, original.scaledScores);
  close(warmer.scores[0][1], 0.5);
  close(warmer.weights[0][1], Math.exp(0.5) / (1 + Math.exp(0.5)));
  assert.ok(warmer.weights[0][1] < original.weights[0][1]);
});

test('adding the same offset to every key shifts scores but preserves weights and output', () => {
  const example = { Q: [[2, 1], [-1, 3]], K: [[0, 1], [1, 0]], V: [[2, -3], [4, 1]] };
  const original = computeAttention(example);
  const shifted = computeAttention({ ...example, K: example.K.map(([x, y]) => [x + 3, y - 2]) });
  original.weights.forEach((row, index) => row.forEach((value, column) => close(shifted.weights[index][column], value)));
  original.output.forEach((row, index) => row.forEach((value, column) => close(shifted.output[index][column], value)));
  close(shifted.rawDotProducts[0][0] - original.rawDotProducts[0][0], 4);
});

test('permuting corresponding key/value rows preserves the attention output', () => {
  const example = createAttentionExample(), original = computeAttention(example);
  const permuted = computeAttention({ ...example, K: [...example.K].reverse(), V: [...example.V].reverse() });
  original.output[0].forEach((value, index) => close(permuted.output[0][index], value));
  original.weights[0].forEach((value, index) => close(permuted.weights[0][2 - index], value));
});

test('stable softmax handles large positive and negative logits without overflow or NaN', () => {
  const result = computeAttention({ Q: [[100, 0], [-100, 0]], K: [[100, 0], [-100, 0]], V: [[1, 2], [3, 4]], temperature: 0.1 });
  assert.deepEqual(result.weights, [[1, 0], [0, 1]]);
  assert.deepEqual(result.output, [[1, 2], [3, 4]]);
  for (const matrix of [result.rawDotProducts, result.scaledScores, result.scores, result.weights, result.output]) assert.ok(allFinite(matrix));
  const negative = computeAttention({ Q: [[100, 0]], K: [[-100, 0], [-99, 0]], V: [[1, 2], [3, 4]] });
  assert.ok(negative.weights[0][1] > 0.999999);
  close(negative.weights[0].reduce((sum, value) => sum + value, 0), 1);
});

test('a single key always has weight one and returns its value vector', () => {
  const result = computeAttention({ Q: [[5, 3], [-5, -2]], K: [[-4, 1]], V: [[7, -8]] });
  assert.deepEqual(result.weights, [[1], [1]]);
  assert.deepEqual(result.output, [[7, -8], [7, -8]]);
});

test('calculation is pure and example factories return independent editable data', () => {
  const first = createAttentionExample(), second = createAttentionExample();
  assert.deepEqual(first.tokens, ['The', 'cat', 'sat']);
  assert.equal(first.selectedQueryIndex, 0);
  const before = JSON.stringify(first);
  computeAttention(first);
  assert.equal(JSON.stringify(first), before);
  first.Q[0][0] = 99;
  first.tokens[0] = 'Changed';
  assert.equal(second.Q[0][0], 1);
  assert.equal(second.tokens[0], 'The');
});

test('invalid dimensions, nonfinite values, excessive norms and temperatures fail before calculation', () => {
  const example = createAttentionExample();
  for (const Q of [null, [], [[1]], [[1, 2, 3]], new Array(1), [new Array(2)], Array.from({ length: 7 }, () => [0, 0]),
    [[NaN, 0]], [[Infinity, 0]], [[-Infinity, 0]], [['1', 0]], [[true, 0]], [[100, 1]], [[1e308, 1e308]]]) {
    assert.throws(() => computeAttention({ ...example, Q }), error => error instanceof TypeError || error instanceof RangeError);
  }
  assert.throws(() => computeAttention({ ...example, K: [[1, 0]], V: [[1, 0], [0, 1]] }), /same number/);
  assert.throws(() => computeAttention({ ...example, V: [[101, 0], [0, 1], [0, 0]] }), /norm/);
  assert.throws(() => computeAttention({ ...example, K: [[NaN, 0], [0, 1], [0, 0]] }), /finite/);
  for (const temperature of [NaN, Infinity, -1, 0, 0.099, 5.001, '1', true]) {
    assert.throws(() => computeAttention({ ...example, temperature }));
  }
  assert.throws(() => computeAttention());
});
