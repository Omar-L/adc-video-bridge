# Test Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add unit tests for pure functions and low-mock code to prevent regressions and support contributors.

**Architecture:** Extract testable pure functions from private methods, add vitest config, write colocated test files. TDD where practical — write tests first for extracted functions, verify existing behavior for everything else.

**Tech Stack:** vitest 2.1.0 (already installed), TypeScript, Node 20+

**Spec:** `docs/superpowers/specs/2026-03-27-test-foundation-design.md`

---

### Task 1: Test infrastructure setup

**Files:**
- Create: `vitest.config.ts`
- Modify: `tsconfig.json`

- [ ] **Step 1: Create vitest config**

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
  },
});
```

- [ ] **Step 2: Exclude test files from build**

In `tsconfig.json`, update the `exclude` array:

```json
"exclude": ["node_modules", "dist", "test", "src/**/*.test.ts"]
```

- [ ] **Step 3: Verify setup**

Run: `npx vitest run`
Expected: "No test files found" (no longer exits with error code since vitest config exists — but still no tests yet). Verify `npm run build` still compiles cleanly.

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts tsconfig.json
git commit -m "chore: add vitest config and exclude test files from build"
```

---

### Task 2: Extract event parsing functions

**Files:**
- Create: `src/events/parse-event.ts`
- Modify: `src/events/alarm-event-listener.ts`

- [ ] **Step 1: Create parse-event.ts with extracted functions**

```typescript
// src/events/parse-event.ts
import { EventType, type AlarmEvent, type MotionEvent } from './types.js';

/** Parse raw WebSocket JSON message into a typed AlarmEvent. */
export function parseBaseEvent(msg: Record<string, unknown>): AlarmEvent {
  const unitId = Number(msg.UnitId) || 0;
  const deviceId = Number(msg.DeviceId) || 0;
  const qstring = typeof msg.QstringForExtraData === 'string' ? msg.QstringForExtraData : '';

  return {
    eventDateUtc: String(msg.EventDateUtc ?? ''),
    unitId,
    deviceId,
    cameraId: `${unitId}-${deviceId}`,
    eventType: Number(msg.EventType) || 0,
    eventValue: Number(msg.EventValue) || 0,
    correlatedId: msg.CorrelatedId != null ? Number(msg.CorrelatedId) : null,
    extraData: parseQueryString(qstring),
    deviceType: Number(msg.DeviceType) || 0,
  };
}

/** Parse URL query string format (key=value&key2=value2) into key-value pairs. */
export function parseQueryString(qs: string): Record<string, string> {
  if (!qs) return {};
  const result: Record<string, string> = {};
  for (const pair of qs.split('&')) {
    const idx = pair.indexOf('=');
    if (idx === -1) {
      result[pair] = '';
    } else {
      result[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
  }
  return result;
}

/** Extract motion-specific fields from a base event. */
export function parseMotionEvent(base: AlarmEvent): MotionEvent {
  return {
    ...base,
    eventType: EventType.MOTION,
    ruleName: decodeURIComponent(base.extraData.rn ?? '').replace(/\+/g, ' '),
    category: Number(base.extraData.category) || 0,
  };
}
```

- [ ] **Step 2: Update alarm-event-listener.ts to use extracted functions**

Replace the private methods and inline motion construction with imports:

```typescript
// At top of file, add import:
import { parseBaseEvent, parseQueryString, parseMotionEvent } from './parse-event.js';

// In handleMessage(), replace:
//   const base = this.parseBaseEvent(msg);
// with:
//   const base = parseBaseEvent(msg);

// In the MOTION case, replace the inline MotionEvent construction:
//   const motion: MotionEvent = { ...base, eventType: EventType.MOTION, ruleName: ..., category: ... };
// with:
//   const motion = parseMotionEvent(base);

// Remove the private parseBaseEvent() and parseQueryString() methods entirely.
```

- [ ] **Step 3: Verify no behavior change**

Run: `npm run build`
Expected: Compiles with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/events/parse-event.ts src/events/alarm-event-listener.ts
git commit -m "refactor: extract event parsing into standalone testable functions"
```

---

### Task 3: Event parsing tests

**Files:**
- Create: `src/events/parse-event.test.ts`

- [ ] **Step 1: Write parseQueryString tests**

```typescript
// src/events/parse-event.test.ts
import { describe, it, expect } from 'vitest';
import { parseQueryString, parseBaseEvent, parseMotionEvent } from './parse-event.js';

describe('parseQueryString', () => {
  it('parses standard key=value pairs', () => {
    expect(parseQueryString('a=1&b=2')).toEqual({ a: '1', b: '2' });
  });

  it('returns empty object for empty string', () => {
    expect(parseQueryString('')).toEqual({});
  });

  it('handles keys without values', () => {
    expect(parseQueryString('flagOnly')).toEqual({ flagOnly: '' });
  });

  it('preserves URL-encoded values (does not decode)', () => {
    expect(parseQueryString('rn=Driveway%20Analytics')).toEqual({ rn: 'Driveway%20Analytics' });
  });

  it('last value wins for duplicate keys', () => {
    expect(parseQueryString('a=1&a=2')).toEqual({ a: '2' });
  });

  it('handles values containing equals signs', () => {
    expect(parseQueryString('data=a=b')).toEqual({ data: 'a=b' });
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run src/events/parse-event.test.ts`
Expected: All PASS

- [ ] **Step 3: Write parseBaseEvent tests**

Add to `src/events/parse-event.test.ts`:

```typescript
describe('parseBaseEvent', () => {
  it('parses a valid event message', () => {
    const msg = {
      EventDateUtc: '2026-03-27T17:07:33.09Z',
      UnitId: 100652375,
      DeviceId: 2048,
      EventType: 210,
      EventValue: 400001,
      CorrelatedId: 308762392372,
      QstringForExtraData: 'rn=Driveway+Video+Analytics&category=4',
      DeviceType: -1,
    };
    const event = parseBaseEvent(msg);
    expect(event.eventDateUtc).toBe('2026-03-27T17:07:33.09Z');
    expect(event.unitId).toBe(100652375);
    expect(event.deviceId).toBe(2048);
    expect(event.cameraId).toBe('100652375-2048');
    expect(event.eventType).toBe(210);
    expect(event.eventValue).toBe(400001);
    expect(event.correlatedId).toBe(308762392372);
    expect(event.extraData).toEqual({ rn: 'Driveway+Video+Analytics', category: '4' });
    expect(event.deviceType).toBe(-1);
  });

  it('composes cameraId from unitId and deviceId', () => {
    const event = parseBaseEvent({ UnitId: 123, DeviceId: 456 });
    expect(event.cameraId).toBe('123-456');
  });

  it('defaults missing numeric fields to 0', () => {
    const event = parseBaseEvent({});
    expect(event.unitId).toBe(0);
    expect(event.deviceId).toBe(0);
    expect(event.eventType).toBe(0);
    expect(event.eventValue).toBe(0);
    expect(event.deviceType).toBe(0);
  });

  it('defaults missing string fields to empty string', () => {
    const event = parseBaseEvent({});
    expect(event.eventDateUtc).toBe('');
  });

  it('maps null CorrelatedId to null', () => {
    const event = parseBaseEvent({ CorrelatedId: null });
    expect(event.correlatedId).toBeNull();
  });

  it('maps missing CorrelatedId (undefined) to null', () => {
    const event = parseBaseEvent({});
    expect(event.correlatedId).toBeNull();
  });

  it('handles missing QstringForExtraData', () => {
    const event = parseBaseEvent({});
    expect(event.extraData).toEqual({});
  });

  it('handles non-string QstringForExtraData', () => {
    const event = parseBaseEvent({ QstringForExtraData: 12345 });
    expect(event.extraData).toEqual({});
  });

  it('coerces string-typed numeric fields', () => {
    const event = parseBaseEvent({ UnitId: '100', DeviceId: '200', EventType: '210' });
    expect(event.unitId).toBe(100);
    expect(event.deviceId).toBe(200);
    expect(event.eventType).toBe(210);
  });
});
```

- [ ] **Step 4: Write parseMotionEvent tests**

Add to `src/events/parse-event.test.ts`:

```typescript
describe('parseMotionEvent', () => {
  it('extracts ruleName from URL-encoded rn field', () => {
    const base = parseBaseEvent({
      EventType: 210,
      QstringForExtraData: 'rn=Driveway+Video+Analytics&category=4',
    });
    const motion = parseMotionEvent(base);
    expect(motion.ruleName).toBe('Driveway Video Analytics');
    expect(motion.category).toBe(4);
    expect(motion.eventType).toBe(210);
  });

  it('handles URL-encoded rn with %20', () => {
    const base = parseBaseEvent({
      QstringForExtraData: 'rn=Back%20Patio%20Analytics&category=4',
    });
    const motion = parseMotionEvent(base);
    expect(motion.ruleName).toBe('Back Patio Analytics');
  });

  it('defaults missing rn to empty string', () => {
    const base = parseBaseEvent({ QstringForExtraData: 'category=4' });
    const motion = parseMotionEvent(base);
    expect(motion.ruleName).toBe('');
  });

  it('defaults missing category to 0', () => {
    const base = parseBaseEvent({ QstringForExtraData: 'rn=Test' });
    const motion = parseMotionEvent(base);
    expect(motion.category).toBe(0);
  });
});
```

- [ ] **Step 5: Run all parse-event tests**

Run: `npx vitest run src/events/parse-event.test.ts`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/events/parse-event.test.ts
git commit -m "test: add event parsing unit tests"
```

---

### Task 4: Config loading tests

**Files:**
- Create: `src/config.test.ts`
- Modify: `src/config.ts` (fix latent null bug)

- [ ] **Step 1: Write config tests**

```typescript
// src/config.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

import { readFileSync, existsSync } from 'node:fs';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

describe('loadConfig', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.spyOn(process, 'cwd').mockReturnValue('/test');
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('');
    // Clear ADC env vars
    delete process.env.ADC_USERNAME;
    delete process.env.ADC_PASSWORD;
    delete process.env.ADC_MFA_TOKEN;
  });

  afterEach(() => {
    process.env = { ...origEnv };
    vi.restoreAllMocks();
  });

  it('throws when no credentials provided', () => {
    expect(() => loadConfig()).toThrow('Alarm.com credentials required');
  });

  it('loads credentials from env vars when no config file', () => {
    process.env.ADC_USERNAME = 'user@test.com';
    process.env.ADC_PASSWORD = 'pass123';
    const config = loadConfig();
    expect(config.alarm.username).toBe('user@test.com');
    expect(config.alarm.password).toBe('pass123');
  });

  it('loads credentials from YAML file', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`
alarm:
  username: "file@test.com"
  password: "filepass"
`);
    const config = loadConfig();
    expect(config.alarm.username).toBe('file@test.com');
    expect(config.alarm.password).toBe('filepass');
  });

  it('applies go2rtc defaults when not in config', () => {
    process.env.ADC_USERNAME = 'u';
    process.env.ADC_PASSWORD = 'p';
    const config = loadConfig();
    expect(config.go2rtc.apiUrl).toBe('http://localhost:1984');
    expect(config.go2rtc.rtspPort).toBe(8554);
  });

  it('applies logging defaults when not in config', () => {
    process.env.ADC_USERNAME = 'u';
    process.env.ADC_PASSWORD = 'p';
    const config = loadConfig();
    expect(config.logging.level).toBe('info');
  });

  it('defaults cameras to empty array when not provided', () => {
    process.env.ADC_USERNAME = 'u';
    process.env.ADC_PASSWORD = 'p';
    const config = loadConfig();
    expect(config.cameras).toEqual([]);
  });

  it('parses cameras array from config', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`
alarm:
  username: "u"
  password: "p"
cameras:
  - id: "123-456"
    name: "test"
    quality: "hd"
`);
    const config = loadConfig();
    expect(config.cameras).toHaveLength(1);
    expect(config.cameras[0].id).toBe('123-456');
  });

  it('returns undefined homebridge when not in config', () => {
    process.env.ADC_USERNAME = 'u';
    process.env.ADC_PASSWORD = 'p';
    const config = loadConfig();
    expect(config.homebridge).toBeUndefined();
  });

  it('parses homebridge config with default motionTimeoutMs', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`
alarm:
  username: "u"
  password: "p"
homebridge:
  motionUrl: "http://10.0.0.50:8080"
`);
    const config = loadConfig();
    expect(config.homebridge?.motionUrl).toBe('http://10.0.0.50:8080');
    expect(config.homebridge?.motionTimeoutMs).toBe(60000);
  });

  it('mfaToken falls back to undefined when empty', () => {
    process.env.ADC_USERNAME = 'u';
    process.env.ADC_PASSWORD = 'p';
    process.env.ADC_MFA_TOKEN = '';
    const config = loadConfig();
    expect(config.alarm.mfaToken).toBeUndefined();
  });

  it('handles empty YAML file without crashing', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('');
    process.env.ADC_USERNAME = 'u';
    process.env.ADC_PASSWORD = 'p';
    const config = loadConfig();
    expect(config.alarm.username).toBe('u');
  });
});
```

- [ ] **Step 2: Run tests — expect the empty YAML test to fail**

Run: `npx vitest run src/config.test.ts`
Expected: Most pass, but "handles empty YAML file without crashing" fails because `yaml.parse('')` returns `null` and the code tries optional chaining on it.

- [ ] **Step 3: Fix the latent bug in config.ts**

In `src/config.ts`, after the `parse(raw)` call, add a null guard:

```typescript
// Change:
fileConfig = parse(raw) as Partial<AppConfig>;
// To:
fileConfig = (parse(raw) as Partial<AppConfig>) ?? {};
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npx vitest run src/config.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "fix: handle null YAML parse result, add config loading tests"
```

---

### Task 5: Retry utility tests

**Files:**
- Create: `src/utils/retry.test.ts`

- [ ] **Step 1: Write retry tests**

```typescript
// src/utils/retry.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./logger.js', () => ({
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { retry, sleep } from './retry.js';

describe('sleep', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('resolves after the specified delay', async () => {
    const promise = sleep(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBeUndefined();
  });
});

describe('retry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and returns on success', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    const promise = retry(fn, { baseDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws last error after all attempts exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));

    const promise = retry(fn, { maxAttempts: 2, baseDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('defaults to 3 max attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    const promise = retry(fn, { baseDelayMs: 100, maxDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(100); // attempt 2
    await vi.advanceTimersByTimeAsync(200); // attempt 3

    await expect(promise).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('wraps non-Error thrown values in Error', async () => {
    const fn = vi.fn().mockRejectedValue('string error');

    const promise = retry(fn, { maxAttempts: 1 });

    await expect(promise).rejects.toThrow('string error');
  });

  it('applies exponential backoff capped by maxDelayMs', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    const promise = retry(fn, {
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 300,
    });

    // Attempt 1 fails → delay 100ms (100 * 2^0)
    await vi.advanceTimersByTimeAsync(100);
    // Attempt 2 fails → delay 200ms (100 * 2^1)
    await vi.advanceTimersByTimeAsync(200);
    // Attempt 3 fails → delay 300ms (min(400, 300) capped)
    await vi.advanceTimersByTimeAsync(300);

    await expect(promise).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('preserves return type (generic)', async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result: number = await retry(fn);
    expect(result).toBe(42);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/utils/retry.test.ts`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/utils/retry.test.ts
git commit -m "test: add retry utility unit tests"
```

---

### Task 6: Auth freshness tests

**Files:**
- Create: `src/auth/alarm-auth.test.ts`

- [ ] **Step 1: Write alarm-auth tests**

```typescript
// src/auth/alarm-auth.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { AlarmAuth } from './alarm-auth.js';

vi.mock('node-alarm-dot-com', () => ({
  login: vi.fn().mockResolvedValue({
    cookie: 'test-cookie',
    ajaxKey: 'test-key',
    expires: Date.now() + 3600000,
    systems: ['12345'],
    identities: {},
  }),
  authenticatedGet: vi.fn().mockResolvedValue({}),
}));

describe('AlarmAuth', () => {
  let auth: AlarmAuth;

  beforeEach(() => {
    auth = new AlarmAuth('user@test.com', 'password');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isSessionFresh', () => {
    it('returns false when never logged in', () => {
      expect(auth.isSessionFresh()).toBe(false);
    });

    it('returns true when logged in recently', async () => {
      await auth.authenticate();
      expect(auth.isSessionFresh()).toBe(true);
    });

    it('returns false when session is older than 55 minutes', async () => {
      await auth.authenticate();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + 55 * 60 * 1000);
      expect(auth.isSessionFresh()).toBe(false);
    });

    it('returns false after destroy()', async () => {
      await auth.authenticate();
      auth.destroy();
      expect(auth.isSessionFresh()).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/auth/alarm-auth.test.ts`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/auth/alarm-auth.test.ts
git commit -m "test: add auth session freshness tests"
```

---

### Task 7: go2rtc API tests

**Files:**
- Create: `src/go2rtc/go2rtc-api.test.ts`

- [ ] **Step 1: Write go2rtc-api tests**

```typescript
// src/go2rtc/go2rtc-api.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { Go2rtcApi } from './go2rtc-api.js';

describe('Go2rtcApi', () => {
  let api: Go2rtcApi;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    api = new Go2rtcApi('http://localhost:1984');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  describe('isHealthy', () => {
    it('returns true when API responds with 200', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
      expect(await api.isHealthy()).toBe(true);
    });

    it('returns false when API responds with 500', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      expect(await api.isHealthy()).toBe(false);
    });

    it('returns false when network error occurs', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await api.isHealthy()).toBe(false);
    });
  });

  describe('getStreams', () => {
    it('returns parsed JSON on success', async () => {
      const streams = { driveway: {} };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(streams),
      });
      expect(await api.getStreams()).toEqual(streams);
    });

    it('throws on non-OK response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      await expect(api.getStreams()).rejects.toThrow('go2rtc API error: 500');
    });

    it('throws on network error', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(api.getStreams()).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('waitReady', () => {
    it('resolves immediately when already healthy', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
      await expect(api.waitReady()).resolves.toBeUndefined();
    });

    it('resolves when becomes healthy during polling', async () => {
      vi.useFakeTimers();
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({ ok: callCount >= 3 });
      });

      const promise = api.waitReady(10_000);
      await vi.advanceTimersByTimeAsync(1000); // poll 2
      await vi.advanceTimersByTimeAsync(1000); // poll 3 (healthy)
      await expect(promise).resolves.toBeUndefined();
    });

    it('throws when timeout is reached', async () => {
      vi.useFakeTimers();
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false });

      const promise = api.waitReady(3000);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);

      await expect(promise).rejects.toThrow('go2rtc not ready after 3000ms');
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/go2rtc/go2rtc-api.test.ts`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/go2rtc/go2rtc-api.test.ts
git commit -m "test: add go2rtc API client tests"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass, no failures.

- [ ] **Step 2: Verify build still works**

Run: `npm run build`
Expected: Compiles cleanly, test files not included in dist/.

- [ ] **Step 3: Verify dist has no test files**

Run: `ls dist/**/*.test.* 2>/dev/null || echo "No test files in dist"`
Expected: "No test files in dist"
