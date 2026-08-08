import { describe, it, expect, vi, beforeEach } from 'vitest';

const { logSpy } = vi.hoisted(() => ({
  logSpy: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./logger.js', () => ({
  createChildLogger: () => logSpy,
}));

import { CircuitBreaker, DEFAULT_COOLDOWN_STEPS_MS } from './circuit-breaker.js';

const MIN = 60_000;

/** Controllable clock so the state machine can be tested without timers. */
function createClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

function createBreaker(overrides: Partial<{ failureThreshold: number; cooldownStepsMs: number[] }> = {}) {
  const clock = createClock();
  const breaker = new CircuitBreaker({
    label: 'test',
    failureThreshold: 3,
    now: clock.now,
    ...overrides,
  });
  return { breaker, clock };
}

describe('CircuitBreaker', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('stays closed and permits attempts below the failure threshold', () => {
    const { breaker } = createBreaker();

    breaker.recordFailure('nope');
    breaker.recordFailure('nope');

    expect(breaker.state).toBe('closed');
    expect(breaker.consecutiveFailures).toBe(2);
    expect(breaker.tryAttempt()).toBe(true);
    expect(breaker.retryAfterMs()).toBe(0);
  });

  it('opens on the threshold-th consecutive failure', () => {
    const { breaker } = createBreaker();

    breaker.recordFailure('a');
    breaker.recordFailure('b');
    expect(breaker.state).toBe('closed');

    breaker.recordFailure('c');
    expect(breaker.state).toBe('open');
    expect(breaker.retryAfterMs()).toBe(5 * MIN);
  });

  it('logs the opening once, loudly, and not again while it stays open', () => {
    const { breaker, clock } = createBreaker();

    for (let i = 0; i < 3; i++) breaker.recordFailure('down');
    expect(logSpy.error).toHaveBeenCalledTimes(1);

    // Suppressed attempts and failed probes must not re-raise the alarm.
    breaker.tryAttempt();
    clock.advance(5 * MIN);
    breaker.tryAttempt();
    breaker.recordFailure('still down');

    expect(logSpy.error).toHaveBeenCalledTimes(1);
  });

  it('denies attempts while open until the cooldown has elapsed', () => {
    const { breaker, clock } = createBreaker();
    for (let i = 0; i < 3; i++) breaker.recordFailure('down');

    clock.advance(5 * MIN - 1);
    expect(breaker.tryAttempt()).toBe(false);
    expect(breaker.retryAfterMs()).toBe(1);

    clock.advance(1);
    expect(breaker.tryAttempt()).toBe(true);
  });

  it('consumes the probe slot, so two callers racing cannot both get through', () => {
    const { breaker, clock } = createBreaker();
    for (let i = 0; i < 3; i++) breaker.recordFailure('down');

    clock.advance(5 * MIN);
    expect(breaker.tryAttempt()).toBe(true);
    expect(breaker.tryAttempt()).toBe(false);
  });

  it('escalates the cooldown on each failed probe: 5m → 15m → 30m → 1h', () => {
    const { breaker, clock } = createBreaker();
    for (let i = 0; i < 3; i++) breaker.recordFailure('down');

    const observed: number[] = [breaker.retryAfterMs()];
    for (let i = 0; i < 3; i++) {
      clock.advance(breaker.retryAfterMs());
      expect(breaker.tryAttempt()).toBe(true);
      breaker.recordFailure('probe failed');
      observed.push(breaker.retryAfterMs());
    }

    expect(observed).toEqual([...DEFAULT_COOLDOWN_STEPS_MS]);
  });

  it('holds the last cooldown step forever rather than giving up', () => {
    const { breaker, clock } = createBreaker();
    for (let i = 0; i < 3; i++) breaker.recordFailure('down');

    for (let i = 0; i < 10; i++) {
      clock.advance(breaker.retryAfterMs());
      expect(breaker.tryAttempt()).toBe(true);
      breaker.recordFailure('probe failed');
    }

    expect(breaker.state).toBe('open');
    expect(breaker.retryAfterMs()).toBe(60 * MIN);
  });

  it('closes on the first successful probe and resets the cooldown ladder', () => {
    const { breaker, clock } = createBreaker();
    for (let i = 0; i < 3; i++) breaker.recordFailure('down');

    // Burn two probes so the cooldown has escalated past its first step.
    for (let i = 0; i < 2; i++) {
      clock.advance(breaker.retryAfterMs());
      breaker.tryAttempt();
      breaker.recordFailure('probe failed');
    }
    expect(breaker.retryAfterMs()).toBe(30 * MIN);

    clock.advance(breaker.retryAfterMs());
    breaker.tryAttempt();
    breaker.recordSuccess();

    expect(breaker.state).toBe('closed');
    expect(breaker.consecutiveFailures).toBe(0);
    expect(breaker.tryAttempt()).toBe(true);

    // Reopening starts at the first step again, not where it left off.
    for (let i = 0; i < 3; i++) breaker.recordFailure('down again');
    expect(breaker.retryAfterMs()).toBe(5 * MIN);
  });

  it('counts only consecutive failures — a success in between clears the tally', () => {
    const { breaker } = createBreaker();

    breaker.recordFailure('a');
    breaker.recordFailure('b');
    breaker.recordSuccess();
    breaker.recordFailure('c');
    breaker.recordFailure('d');

    expect(breaker.state).toBe('closed');
    expect(breaker.consecutiveFailures).toBe(2);
  });

  it('honours a custom threshold and cooldown ladder', () => {
    const { breaker, clock } = createBreaker({
      failureThreshold: 1,
      cooldownStepsMs: [1_000, 2_000],
    });

    breaker.recordFailure('down');
    expect(breaker.state).toBe('open');
    expect(breaker.retryAfterMs()).toBe(1_000);

    clock.advance(1_000);
    breaker.tryAttempt();
    breaker.recordFailure('probe failed');
    expect(breaker.retryAfterMs()).toBe(2_000);
  });

  it('reset() returns to the initial state without logging a recovery', () => {
    const { breaker } = createBreaker();
    for (let i = 0; i < 3; i++) breaker.recordFailure('down');

    breaker.reset();

    expect(breaker.state).toBe('closed');
    expect(breaker.consecutiveFailures).toBe(0);
    expect(breaker.retryAfterMs()).toBe(0);
    expect(logSpy.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('recovered'),
    );
  });
});
