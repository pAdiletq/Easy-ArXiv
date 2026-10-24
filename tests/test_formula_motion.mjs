import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotion } from '../extensions/formula-lens/motion.js';

function fakeFrames(options = {}) {
  let now = 0;
  let nextHandle = 0;
  const queued = new Map();
  const cancelled = [];
  const motion = createMotion({
    requestFrame(callback) { const handle = ++nextHandle; queued.set(handle, callback); return handle; },
    cancelFrame(handle) { cancelled.push(handle); queued.delete(handle); },
    clock: () => now,
    reducedMotion: false,
    ...options,
  });
  return {
    motion, queued, cancelled,
    at(time) {
      now = time;
      const callbacks = [...queued.values()];
      queued.clear();
      callbacks.forEach(callback => callback(time));
    },
  };
}

test('one-shot cubic motion eases at each end, is monotonic and finishes exactly once', () => {
  const { motion, queued, at } = fakeFrames();
  const values = [];
  let finishes = 0;
  motion.play({ from: 0, to: 1, duration: 1000, onFrame: value => values.push(value), onFinish: () => finishes++ });
  assert.deepEqual(values, [0]);
  assert.equal(motion.active, true);
  [250, 500, 750, 1000, 2000].forEach(at);
  assert.deepEqual(values, [0, 0.0625, 0.5, 0.9375, 1]);
  assert.ok(values.every((value, index) => !index || value >= values[index - 1]));
  assert.equal(finishes, 1);
  assert.equal(motion.active, false);
  assert.equal(queued.size, 0);
});

test('decreasing endpoints remain ordered and clock reversal cannot rewind progress', () => {
  const { motion, at } = fakeFrames();
  const values = [];
  motion.play({ from: 4, to: -4, duration: 1000, onFrame: value => values.push(value) });
  [500, 300, 750, 1100].forEach(at);
  assert.deepEqual(values, [4, 0, 0, -3.5, -4]);
});

test('duration is bounded to four seconds and defaults to 900 ms', () => {
  const { motion, at } = fakeFrames();
  const values = [];
  motion.play({ from: 0, to: 1, duration: 60000, onFrame: value => values.push(value) });
  at(2000);
  assert.equal(values.at(-1), 0.5);
  at(4000);
  assert.equal(values.at(-1), 1);
  motion.play({ from: 1, to: 2, onFrame: value => values.push(value) });
  at(4900);
  assert.equal(values.at(-1), 2);
  assert.equal(motion.active, false);
});

test('cancel invalidates even a stale callback delivered after cancellation', () => {
  const { motion, queued, cancelled, at } = fakeFrames();
  const values = [];
  let finished = false;
  motion.play({ from: 0, to: 1, onFrame: value => values.push(value), onFinish: () => { finished = true; } });
  const stale = [...queued.values()][0];
  motion.cancel();
  motion.cancel();
  stale(1000);
  at(1000);
  assert.deepEqual(values, [0]);
  assert.equal(cancelled.length, 1);
  assert.equal(queued.size, 0);
  assert.equal(motion.active, false);
  assert.equal(finished, false);
});

test('replacement cannot be changed or finished by the previous queued callback', () => {
  const { motion, queued, at } = fakeFrames();
  const oldValues = [];
  const newValues = [];
  let oldFinished = false;
  motion.play({ from: 0, to: 1, onFrame: value => oldValues.push(value), onFinish: () => { oldFinished = true; } });
  const stale = [...queued.values()][0];
  motion.play({ from: 10, to: 20, duration: 1000, onFrame: value => newValues.push(value) });
  stale(1000);
  assert.equal(queued.size, 1);
  at(1000);
  assert.deepEqual(oldValues, [0]);
  assert.deepEqual(newValues, [10, 20]);
  assert.equal(oldFinished, false);
});

test('reduced motion finishes synchronously without a frame request', () => {
  for (const reducedMotion of [true, () => true]) {
    const { motion, queued } = fakeFrames({ reducedMotion });
    const calls = [];
    motion.play({ from: 0, to: 1, onFrame: value => calls.push(value), onFinish: () => calls.push('finished') });
    assert.deepEqual(calls, [1, 'finished']);
    assert.equal(motion.active, false);
    assert.equal(queued.size, 0);
  }
});

test('zero duration and equal endpoints finish synchronously', () => {
  const { motion, queued } = fakeFrames();
  const values = [];
  let finishes = 0;
  motion.play({ from: -2, to: 4, duration: 0, onFrame: value => values.push(value), onFinish: () => finishes++ });
  motion.play({ from: 7, to: 7, onFrame: value => values.push(value), onFinish: () => finishes++ });
  assert.deepEqual(values, [4, 7]);
  assert.equal(finishes, 2);
  assert.equal(queued.size, 0);
});

test('cancel from the initial or terminal render prevents stale scheduling and finish', () => {
  const { motion, queued, at } = fakeFrames();
  motion.play({ from: 0, to: 1, onFrame: () => motion.cancel() });
  assert.equal(queued.size, 0);
  let finishes = 0;
  motion.play({ from: 0, to: 1, duration: 100, onFrame: value => { if (value === 1) motion.cancel(); }, onFinish: () => finishes++ });
  at(100);
  assert.equal(finishes, 0);
  assert.equal(motion.active, false);
});

test('a re-entrant replacement from a terminal render keeps only the new run active', () => {
  const { motion, queued, at } = fakeFrames();
  const values = [];
  let oldFinishes = 0;
  motion.play({
    from: 0, to: 1, duration: 100,
    onFrame(value) {
      if (value === 1) motion.play({ from: 2, to: 3, duration: 100, onFrame: current => values.push(current) });
    },
    onFinish: () => oldFinishes++,
  });
  at(100);
  assert.equal(motion.active, true);
  assert.equal(queued.size, 1);
  assert.equal(oldFinishes, 0);
  at(200);
  assert.deepEqual(values, [2, 3]);
});

test('invalid inputs fail before replacing a valid run', () => {
  const { motion } = fakeFrames();
  motion.play({ from: 0, to: 1, onFrame() {} });
  for (const invalid of [NaN, Infinity, -Infinity, '1', undefined]) {
    assert.throws(() => motion.play({ from: invalid, to: 1, onFrame() {} }), TypeError);
    assert.throws(() => motion.play({ from: 0, to: invalid, onFrame() {} }), TypeError);
  }
  for (const duration of [-1, Infinity, NaN, '1']) {
    assert.throws(() => motion.play({ from: 0, to: 1, duration, onFrame() {} }), RangeError);
  }
  assert.throws(() => motion.play({ from: 0, to: 1 }), TypeError);
  assert.throws(() => motion.play({ from: 0, to: 1, onFrame() {}, onFinish: true }), TypeError);
  assert.equal(motion.active, true);
});

test('renderer failures cancel the current run without leaving a pending frame', () => {
  const { motion, queued, at } = fakeFrames();
  assert.throws(() => motion.play({ from: 0, to: 1, onFrame() { throw new Error('Render failed'); } }), /Render failed/);
  assert.equal(motion.active, false);
  assert.equal(queued.size, 0);
  motion.play({ from: 0, to: 1, onFrame(value) { if (value > 0) throw new Error('Later render failed'); } });
  assert.throws(() => at(400), /Later render failed/);
  assert.equal(motion.active, false);
  assert.equal(queued.size, 0);
});

test('interpolation remains finite even when the endpoint difference would overflow', () => {
  const { motion, at } = fakeFrames();
  const values = [];
  motion.play({ from: -1e308, to: 1e308, duration: 100, onFrame: value => values.push(value) });
  at(50);
  at(100);
  assert.deepEqual(values, [-1e308, 0, 1e308]);
});
