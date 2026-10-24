import test from 'node:test';
import assert from 'node:assert/strict';
import { FormulaError, prepareExpression, compileFormula, evaluateFormula, sampleFormula, classifyValue } from '../extensions/formula-lens/formula-engine.js';

const close = (value, expected, tolerance = 1e-10) => assert.ok(Math.abs(value - expected) <= tolerance, `${value} differs from ${expected}`);
const calculate = (expression, bindings = {}) => evaluateFormula(compileFormula(expression), bindings);
const rejects = (action, code) => assert.throws(action, error => error instanceof FormulaError && (!code || error.code === code));

test('normalization preserves case and makes explicit Unicode multiplication, powers, and Greek variables', () => {
  const result = prepareExpression(' y = A × x² − α ÷ 2 ');
  assert.equal(result.expression, 'y = A * x^(2) - α / 2');
  assert.equal(result.changed, true);
  const program = compileFormula(result.expression);
  assert.deepEqual(program.variables, ['A', 'x', 'α']);
  assert.equal(program.assignment, 'y');
  assert.equal(evaluateFormula(program, { A: 2, x: 3, α: 4 }), 16);
  assert.equal(prepareExpression('A + a').expression, 'A + a');
  assert.equal(calculate('A + a', { A: 5, a: 2 }), 7);
});

test('nested LaTeX fractions and square roots become arithmetic without inventing omitted bars', () => {
  const prepared = prepareExpression(String.raw`\frac{1}{\sqrt{2\pi}}\exp\left(-\frac{x^{2}}{2}\right)`);
  close(calculate(prepared.expression, { x: 0 }), 1 / Math.sqrt(2 * Math.PI));
  const flattened = prepareExpression('a\nb');
  assert.ok(flattened.warnings.some(warning => warning.includes('fraction bars')));
  assert.equal(flattened.expression, 'a b');
  assert.ok(!flattened.expression.includes('/'));
  rejects(() => compileFormula(prepareExpression(String.raw`\frac{a}`).expression), 'SYNTAX');
});

test('subscripts, mathematical Unicode letters and explicit root notation survive normalization', () => {
  const result = prepareExpression('𝑦 = dₖ + √(x + 1)');
  assert.equal(result.expression, 'y = d_k + sqrt(x + 1)');
  assert.equal(calculate(result.expression, { d_k: 2, x: 8 }), 5);
  assert.ok(prepareExpression('Qᵀ').warnings.some(warning => warning.includes('transpose')));
  assert.equal(calculate(prepareExpression('x⁻²').expression, { x: 2 }), 0.25);
});

test('operator precedence, unary signs, right-associative powers and implicit products are mathematical', () => {
  assert.equal(calculate('-2^2'), -4);
  assert.equal(calculate('2^-3'), 0.125);
  assert.equal(calculate('2^3^2'), 512);
  assert.equal(calculate('2(x+1)(x-1)', { x: 3 }), 16);
  close(calculate('2pi'), 2 * Math.PI);
  close(calculate('1.2e-3 * 2E3'), 2.4);
  const program = compileFormula('QK');
  assert.deepEqual(program.variables, ['QK']);
  assert.equal(evaluateFormula(program, { QK: 7 }), 7);
});

test('programs are serializable, expose free parameters and label definitions instead of solving equations', () => {
  const program = compileFormula('f(x) = a*x^2 + b');
  assert.equal(program.assignment, 'f(x)');
  assert.deepEqual(program.suggestedBindings, { a: 1, x: 0, b: 1 });
  assert.ok(program.explanation.length > 0 && program.explanation.length <= 180);
  const restored = JSON.parse(JSON.stringify(program));
  assert.equal(evaluateFormula(restored, Object.assign(Object.create(null), { a: 2, x: 3, b: 1 })), 19);
  assert.equal(compileFormula('a=b+c').assignment, 'a');
  rejects(() => compileFormula('x=x+1'), 'RELATIONSHIP');
  rejects(() => compileFormula('x^2+y^2=1'), 'RELATIONSHIP');
  rejects(() => compileFormula('x=y=z'), 'RELATIONSHIP');
});

test('a Gaussian density computes known values and samples a symmetric curve with an independent axis', () => {
  const program = compileFormula('f(x)=exp(-((x-μ)^2)/(2*σ^2))/(σ*sqrt(2*pi))');
  close(evaluateFormula(program, { x: 0, μ: 0, σ: 1 }), 1 / Math.sqrt(2 * Math.PI));
  close(evaluateFormula(program, { x: 2, μ: 2, σ: 3 }), 1 / (3 * Math.sqrt(2 * Math.PI)));
  const points = sampleFormula(program, { μ: 0, σ: 1 }, { variable: 'x', min: -3, max: 3, count: 101 });
  assert.equal(points.length, 101);
  close(points[0][1], points[100][1]);
  close(points[50][0], 0);
  assert.ok(points[50][1] > points[0][1]);
});

test('positional encoding and a learning-rate schedule work through generic operators', () => {
  const positional = compileFormula('PE = sin(pos / (10000^(2*i/d_model)))');
  close(evaluateFormula(positional, { pos: Math.PI / 2, i: 0, d_model: 512 }), 1);
  assert.equal(evaluateFormula(positional, { pos: 0, i: 12, d_model: 512 }), 0);
  const learningRate = compileFormula('η = d_model^(-0.5) * min(t^(-0.5), t * warmup^(-1.5))');
  close(evaluateFormula(learningRate, { d_model: 512, t: 4000, warmup: 4000 }), 1 / Math.sqrt(512 * 4000));
  const early = evaluateFormula(learningRate, { d_model: 512, t: 1000, warmup: 4000 });
  const peak = evaluateFormula(learningRate, { d_model: 512, t: 4000, warmup: 4000 });
  const late = evaluateFormula(learningRate, { d_model: 512, t: 8000, warmup: 4000 });
  assert.ok(early < peak && late < peak);
});

test('real elementary functions and constants cover unrelated numerical expressions', () => {
  close(calculate('ln(e) + log(8,2) + log10(100) + log2(16)'), 10);
  assert.equal(calculate('min(3,-2,4) + max([1,7,3])'), 5);
  close(calculate('sqrt(9)+cbrt(-8)+abs(-3)+pow(2,3)'), 12);
  close(calculate('sin(pi/2)+cos(0)+atan2(0,1)'), 2);
  assert.equal(calculate('floor(2.9)+ceil(2.1)+round(2.4)+sign(-5)'), 6);
  close(calculate('tanh(0)+sinh(0)+cosh(0)'), 1);
  close(calculate(prepareExpression(String.raw`\sin{\frac{\pi}{2}}`).expression), 1);
});

test('vectors, matrices, scalar scaling and shape-sensitive operations produce actual results', () => {
  assert.equal(calculate('dot([1,2],[3,4])'), 11);
  close(calculate('norm([3,4])'), 5);
  close(calculate('norm([[1,2],[3,4]])'), Math.sqrt(30));
  assert.deepEqual(calculate('transpose([[1,2,3],[4,5,6]])'), [[1,4],[2,5],[3,6]]);
  assert.deepEqual(calculate('matmul([[1,2],[3,4]],[[5,6],[7,8]])'), [[19,22],[43,50]]);
  assert.deepEqual(calculate('matmul([[1,2],[3,4]],[5,6])'), [17,39]);
  assert.deepEqual(calculate('matmul([5,6],[[1,2],[3,4]])'), [23,34]);
  assert.deepEqual(calculate('[[1,2],[3,4]]*[[1,0],[0,1]]'), [[1,2],[3,4]]);
  assert.deepEqual(calculate('2*[1,2]-[1,1]'), [1,3]);
  assert.deepEqual(calculate('A / 2', { A: [[2,4],[6,8]] }), [[1,2],[3,4]]);
  assert.deepEqual(classifyValue([[1,2],[3,4]]), { kind: 'matrix', shape: [2,2] });
});

test('softmax is numerically stable and the generic operator composition evaluates matrix attention', () => {
  assert.deepEqual(calculate('softmax([10000,-10000])'), [1,0]);
  assert.deepEqual(calculate('softmax([1e308,-1e308])'), [1,0]);
  assert.deepEqual(calculate('softmax([[1,1],[2,2]])'), [[0.5,0.5],[0.5,0.5]]);
  const program = compileFormula('matmul(softmax(matmul(Q,transpose(K))/sqrt(d_k)),V)');
  const result = evaluateFormula(program, { Q: [[0,0]], K: [[1,0],[0,1]], V: [[2,0],[0,4]], d_k: 2 });
  assert.deepEqual(result, [[1,2]]);
  rejects(() => evaluateFormula(program, program.suggestedBindings), 'SHAPE');
});

test('sum and integral bind local variables, keep external parameters and do not mutate inputs', () => {
  const sum = compileFormula('sum(i^2,i,1,n)');
  assert.deepEqual(sum.variables, ['n']);
  assert.equal(evaluateFormula(sum, { n: 3 }), 14);
  assert.equal(calculate('sum(sum(i+j,j,1,2),i,1,2)'), 12);
  assert.equal(calculate('sum(at(a,i),i,1,3)', { a: [2,4,6] }), 12);
  close(calculate('integrate(x^2,x,0,1)'), 1/3);
  close(calculate('integrate(sin(x),x,0,pi)'), 2, 1e-7);
  close(calculate('integrate(x^2,x,1,0)'), -1/3);
  const bindings = { n: 3, i: 100 }, before = JSON.stringify(bindings);
  assert.equal(evaluateFormula(sum, bindings), 14);
  assert.equal(JSON.stringify(bindings), before);
  assert.equal(calculate('sum(i,i,3,1)'), 0);
});

test('graphs use null at invalid real-domain points without substituting zero or joining through poles', () => {
  const logarithm = sampleFormula(compileFormula('log(x)'), {}, { variable: 'x', min: -1, max: 1, count: 3 });
  assert.deepEqual(logarithm, [[-1,null],[0,null],[1,0]]);
  const reciprocal = sampleFormula(compileFormula('1/x'), {}, { variable: 'x', min: -1, max: 1, count: 3 });
  assert.deepEqual(reciprocal, [[-1,-1],[0,null],[1,1]]);
  const root = sampleFormula(compileFormula('sqrt(x)'), {}, { variable: 'x', min: -1, max: 1, count: 3 });
  assert.deepEqual(root, [[-1,null],[0,0],[1,1]]);
  rejects(() => sampleFormula(compileFormula('a*x'), {}, { variable: 'x', min: 0, max: 1, count: 3 }), 'MISSING_BINDING');
});

test('unsupported functions, relationships, units and dangerous program constructs are explicit errors', () => {
  for (const expression of ['foo(x)', 'Attention(Q,K,V)', 'integral(x)', 'complex(1,2)']) rejects(() => compileFormula(expression), 'UNKNOWN_FUNCTION');
  rejects(() => compileFormula('5 kg'), 'UNITS');
  rejects(() => compileFormula('10cm'), 'UNITS');
  rejects(() => compileFormula('2+3i'), 'COMPLEX');
  assert.equal(calculate('2*i', { i: 3 }), 6);
  for (const expression of ['x.constructor', 'window', 'globalThis', 'constructor', '__proto__', 'prototype',
    'import(x)', 'evaluate(x)', 'parse(x)', 'Function(x)', 'f(x)=x;fetch(x)', 'a[0]', 'x=>x', 'x==1', '"x"', 'NaN', 'Infinity']) {
    rejects(() => compileFormula(expression));
  }
  rejects(() => evaluateFormula({ ast: { type: 'AccessorNode' } }, {}), 'UNSUPPORTED');
  rejects(() => evaluateFormula(compileFormula('x'), { x: () => 7 }));
  const malicious = Object.create(null); malicious.__proto__ = 1;
  rejects(() => evaluateFormula(compileFormula('x'), malicious), 'INVALID_BINDING');
});

test('shape mismatches, singular values and real-domain failures do not produce invented outputs', () => {
  for (const expression of ['1/0', 'sqrt(-1)', 'log(0)', 'log(4,1)', 'exp(1000)', '(-1)^0.5', 'asin(2)']) rejects(() => calculate(expression), 'DOMAIN');
  for (const expression of ['dot([1,2],[1])', 'matmul([[1,2]],[[3,4]])', 'transpose([1,2])', '[1,2]+[3]',
    '[[1],[2,3]]', '[[[1]]]', '[1,2]*[3,4]', '2/[1,2]', 'softmax(3)']) rejects(() => calculate(expression), 'SHAPE');
  rejects(() => calculate('x', { x: Infinity }), 'DOMAIN');
  rejects(() => calculate('at([1,2],0)'), 'DOMAIN');
  rejects(() => calculate('x', { x: new Array(2) }), 'SHAPE');
  rejects(() => calculate('x', { x: [new Array(2)] }), 'SHAPE');
});

test('resource budgets bound parsing, matrices, variables, loops and sampling', () => {
  rejects(() => prepareExpression('x'.repeat(2001)), 'LIMIT');
  rejects(() => compileFormula('('.repeat(40)+'1'+')'.repeat(40)), 'LIMIT');
  rejects(() => compileFormula(Array.from({ length: 17 }, (_, i) => 'a'+i).join('+')), 'LIMIT');
  rejects(() => calculate('['+Array.from({ length: 17 }, () => '1').join(',')+']'), 'LIMIT');
  rejects(() => calculate('sum(i,i,1,1001)'), 'LIMIT');
  rejects(() => calculate('sum(sum(i+j,j,1,1000),i,1,1000)'), 'LIMIT');
  rejects(() => sampleFormula(compileFormula('x'), {}, { variable: 'x', min: 0, max: 1, count: 202 }), 'LIMIT');
  rejects(() => sampleFormula(compileFormula('x'), {}, { variable: 'z', min: 0, max: 1, count: 3 }), 'INVALID_AXIS');
  rejects(() => sampleFormula(compileFormula('x'), {}, { variable: 'x', min: 1, max: 0, count: 3 }), 'INVALID_RANGE');
});

test('explanations describe actual operators in short readable sentences without paper-specific claims', () => {
  for (const [expression, meaning] of [
    ['exp(-x^2)', /exponential/], ['sin(x)', /periodic/], ['softmax(v)', /weights/],
    ['matmul(A,B)', /matrix/], ['min(x,y)', /smallest/], ['integrate(x^2,x,0,1)', /approximate/],
    ['sqrt(x)', /nonnegative/], ['norm(A)', /Frobenius/],
  ]) {
    const text = compileFormula(expression).explanation;
    assert.match(text, meaning);
    assert.ok(text.length <= 180);
    assert.ok(!text.includes('Operations:'));
  }
});
