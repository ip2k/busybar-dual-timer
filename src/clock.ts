/**
 * A monotonic millisecond clock.
 *
 * Everything that measures a *duration* must use this rather than `Date.now()`.
 * Wall-clock time is not monotonic: NTP can step it, and a long-running service
 * host will do exactly that at some point. A backwards step mid-countdown makes
 * a timer gain time; a forwards step makes it lose time, or expire instantly.
 *
 * `performance.now()` is milliseconds since process start and never goes
 * backwards, which is all a countdown needs. Wall-clock time is still the right
 * choice for anything that has to line up with the outside world — the device's
 * own `State.timestamp`, or a log line.
 */
export function monotonicMs(): number {
  return performance.now();
}

/**
 * Milliseconds to wait so the next tick lands on a multiple of `tickMs` past
 * the wall-clock second.
 *
 * `setInterval` fires relative to whenever it was started, so the tick that
 * redraws a new second sits at an arbitrary offset inside it — and drifts.
 * Computing each delay from the clock instead keeps ticks on the boundary and
 * absorbs a slow tick rather than accumulating it.
 *
 * Always returns at least 1ms: landing exactly on a boundary should wait a full
 * period, not schedule a zero-delay tick that fires again immediately.
 */
export function msUntilNextTick(tickMs: number, now: number): number {
  const remainder = now % tickMs;
  return remainder === 0 ? tickMs : tickMs - remainder;
}
