/** One-shot scalar motion. The caller owns rendering and any example values. */
export function createMotion({
  requestFrame = callback => globalThis.requestAnimationFrame(callback),
  cancelFrame = handle => globalThis.cancelAnimationFrame(handle),
  clock = () => globalThis.performance.now(),
  reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
} = {}) {
  if (![requestFrame, cancelFrame, clock].every(value => typeof value === 'function')) {
    throw new TypeError('Motion frame functions and clock must be functions.');
  }
  if (typeof reducedMotion !== 'function' && typeof reducedMotion !== 'boolean') {
    throw new TypeError('Reduced motion must be a boolean or a function.');
  }

  let epoch = 0;
  let pendingFrame;
  let running = false;

  function cancel() {
    epoch += 1;
    running = false;
    if (pendingFrame !== undefined) {
      const handle = pendingFrame;
      pendingFrame = undefined;
      cancelFrame(handle);
    }
  }

  function play({ from, to, duration = 900, onFrame, onFinish } = {}) {
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new TypeError('Motion endpoints must be finite numbers.');
    }
    if (!Number.isFinite(duration) || duration < 0) {
      throw new RangeError('Motion duration must be a finite non-negative number.');
    }
    if (typeof onFrame !== 'function' || (onFinish !== undefined && typeof onFinish !== 'function')) {
      throw new TypeError('Motion callbacks must be functions.');
    }
    const instant = (typeof reducedMotion === 'function' ? reducedMotion() : reducedMotion)
      || duration === 0 || from === to;
    const startedAt = instant ? 0 : clock();
    if (!Number.isFinite(startedAt)) throw new TypeError('Motion clock must return a finite number.');
    const boundedDuration = Math.min(duration, 4000);
    cancel();
    const run = epoch;
    running = true;
    let progress = 0;

    function emit(value, complete = false) {
      if (run !== epoch) return;
      if (complete) running = false;
      try {
        onFrame(value);
      } catch (error) {
        if (run === epoch) cancel();
        throw error;
      }
      if (complete && run === epoch) onFinish?.();
    }

    function schedule() {
      try {
        pendingFrame = requestFrame(tick);
      } catch (error) {
        if (run === epoch) cancel();
        throw error;
      }
    }

    function tick() {
      if (run !== epoch || !running) return;
      pendingFrame = undefined;
      const now = clock();
      if (!Number.isFinite(now)) {
        cancel();
        throw new TypeError('Motion clock must return a finite number.');
      }
      // A clock adjustment must never move an example backwards.
      progress = Math.max(progress, Math.min(1, Math.max(0, (now - startedAt) / boundedDuration)));
      if (progress === 1) {
        emit(to, true);
        return;
      }
      const eased = progress < 0.5
        ? 4 * progress ** 3
        : 1 - (-2 * progress + 2) ** 3 / 2;
      emit(from * (1 - eased) + to * eased);
      if (run === epoch && running) schedule();
    }

    if (instant) {
      emit(to, true);
      return;
    }
    emit(from);
    if (run === epoch && running) schedule();
  }

  return { play, cancel, get active() { return running; } };
}
