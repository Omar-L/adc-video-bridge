import { createChildLogger } from './logger.js';

const log = createChildLogger('circuit');

export type CircuitState = 'closed' | 'open';

/**
 * Waits between probes while the circuit is open: 5m → 15m → 30m → 1h.
 * The last step repeats forever — the circuit never stops probing.
 */
export const DEFAULT_COOLDOWN_STEPS_MS: readonly number[] = [
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
];

export const DEFAULT_FAILURE_THRESHOLD = 5;

export interface CircuitBreakerOptions {
  /** Identifies the guarded loop in logs, e.g. `events` or `videoToken:<cameraId>`. */
  label: string;
  /** Consecutive failures that open the circuit. */
  failureThreshold?: number;
  /** Escalating waits between probes while open. The last entry repeats forever. */
  cooldownStepsMs?: readonly number[];
  /** Injectable clock, for tests. */
  now?: () => number;
}

/**
 * Bounds how long a retry loop keeps hammering Alarm.com.
 *
 * Exponential backoff already bounds the *rate* between attempts, but nothing
 * bounds the *duration* of attempting: a saturated ladder is still an infinite
 * loop, just a politer one. Once `failureThreshold` consecutive attempts fail
 * the circuit opens, the loop pauses, and attempts continue only as occasional
 * probes on an escalating cooldown — forever. One success closes it.
 *
 * 🔑 **The breaker cannot decide what a failure is; the caller must.**
 * The failure that matters here is "did not produce a usable result", not
 * "threw". In an observed multi-hour outage `fetchVideoSource()` returned
 * `null` and `fetchVideoTokenSilent()` logged a warning and returned `null` —
 * nothing threw and no `error` event was emitted, so to every error path in
 * this codebase a seven-hour failure looked like a series of successful calls
 * returning nothing. Call sites must therefore call {@link recordFailure} on
 * their empty-result branch, not only from `catch`.
 *
 * Self-healing is deliberate. That outage ended when the camera was
 * power-cycled; a breaker that stayed open until the process restarted would
 * have kept the cameras dark long after they were healthy again.
 *
 * The breaker owns no timers. Each loop keeps its own scheduling and asks
 * {@link retryAfterMs} how long to wait, so there is nothing extra to clear on
 * shutdown.
 */
export class CircuitBreaker {
  private readonly label: string;
  private readonly failureThreshold: number;
  private readonly cooldownStepsMs: readonly number[];
  private readonly now: () => number;

  private currentState: CircuitState = 'closed';
  private failures = 0;
  private cooldownIndex = 0;
  private nextProbeAt = 0;
  private openedAt = 0;

  constructor(opts: CircuitBreakerOptions) {
    this.label = opts.label;
    this.failureThreshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownStepsMs = opts.cooldownStepsMs ?? DEFAULT_COOLDOWN_STEPS_MS;
    this.now = opts.now ?? Date.now;
  }

  get state(): CircuitState {
    return this.currentState;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  /** Milliseconds until the next attempt is permitted. Always 0 while closed. */
  retryAfterMs(): number {
    if (this.currentState === 'closed') return 0;
    return Math.max(0, this.nextProbeAt - this.now());
  }

  /**
   * Ask permission to make an attempt.
   *
   * Always true while closed. While open it is true only when a probe is due,
   * and saying yes **consumes** that probe: the next one is pushed out by the
   * current cooldown, so two callers racing at the same instant cannot both
   * get through.
   */
  tryAttempt(): boolean {
    if (this.currentState === 'closed') return true;

    if (this.now() < this.nextProbeAt) return false;

    this.nextProbeAt = this.now() + this.currentCooldownMs();
    log.info(
      { label: this.label, failures: this.failures },
      'Circuit open — probing to see whether Alarm.com has recovered',
    );
    return true;
  }

  /** Record an attempt that produced a usable result. Closes the circuit. */
  recordSuccess(): void {
    if (this.currentState === 'open') {
      const openForMs = this.now() - this.openedAt;
      log.warn(
        { label: this.label, failures: this.failures, openForMin: Math.round(openForMs / 60_000) },
        'Circuit closed — Alarm.com recovered',
      );
    }

    this.currentState = 'closed';
    this.failures = 0;
    this.cooldownIndex = 0;
    this.nextProbeAt = 0;
    this.openedAt = 0;
  }

  /**
   * Record an attempt that produced no usable result — whether it threw, or
   * returned nothing useful without throwing. Opens the circuit once
   * `failureThreshold` consecutive failures accumulate; escalates the cooldown
   * when a probe fails.
   */
  recordFailure(reason: string): void {
    this.failures++;

    if (this.currentState === 'open') {
      this.cooldownIndex = Math.min(this.cooldownIndex + 1, this.cooldownStepsMs.length - 1);
      this.nextProbeAt = this.now() + this.currentCooldownMs();
      log.warn(
        { label: this.label, failures: this.failures, nextProbeInMin: this.currentCooldownMs() / 60_000, reason },
        'Probe failed — circuit stays open',
      );
      return;
    }

    if (this.failures < this.failureThreshold) return;

    this.currentState = 'open';
    this.openedAt = this.now();
    this.cooldownIndex = 0;
    this.nextProbeAt = this.now() + this.currentCooldownMs();

    // Logged once, loudly, on the transition. Suppressed attempts afterwards
    // are debug-level so an outage does not bury the line that explains it.
    log.error(
      { label: this.label, failures: this.failures, nextProbeInMin: this.currentCooldownMs() / 60_000, reason },
      'Circuit OPEN — pausing this loop after %d consecutive failures. Probing every so often; it will close itself on the first success.',
      this.failures,
    );
  }

  /** Return to the initial closed state without logging a recovery. */
  reset(): void {
    this.currentState = 'closed';
    this.failures = 0;
    this.cooldownIndex = 0;
    this.nextProbeAt = 0;
    this.openedAt = 0;
  }

  private currentCooldownMs(): number {
    return this.cooldownStepsMs[Math.min(this.cooldownIndex, this.cooldownStepsMs.length - 1)];
  }
}
