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
