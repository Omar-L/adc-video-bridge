# Test Foundation Design

## Goal

Add a foundation of unit tests to prevent regressions and provide a safety net for contributors. Start with pure functions and low-mock tests — the highest ROI with the least effort.

## Infrastructure

### vitest.config.ts

Minimal config at project root:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
  },
});
```

### Conventions

- Test files colocated with source: `src/config.test.ts`, `src/utils/retry.test.ts`
- One `describe` per exported function or class
- `it` blocks describe behavior, not implementation
- No shared test utilities to start — extract patterns later if needed
- Existing scripts (`"test": "vitest run"`, `"test:watch": "vitest"`) already work — no changes needed to package.json

### tsconfig

Exclude test files from the build output. Add to `tsconfig.json` exclude array:

```json
"exclude": ["src/**/*.test.ts"]
```

### Async + fake timers

vitest fake timers block async code that `await`s `setTimeout`-based promises. Use `vi.advanceTimersByTimeAsync()` and run timer advancement in parallel with the awaited call:

```typescript
const promise = retry(fn, opts);
await vi.advanceTimersByTimeAsync(delayMs);
await promise;
```

This pattern applies to `retry.test.ts` and `go2rtc-api.test.ts` (`waitReady`).

## Refactoring: Extract event parsing

**Current state:** `parseBaseEvent()` and `parseQueryString()` are private methods on `AlarmEventListener`. They contain pure data transformation logic but can't be tested without instantiating the class and mocking WebSocket.

**Change:** Extract into `src/events/parse-event.ts` as standalone exported functions. `AlarmEventListener` imports and calls them. No behavior change.

### New file: `src/events/parse-event.ts`

Exports:
- `parseBaseEvent(msg: Record<string, unknown>): AlarmEvent` — maps raw WebSocket JSON to typed event
- `parseQueryString(qs: string): Record<string, string>` — parses URL query string format from `QstringForExtraData`
- `parseMotionEvent(base: AlarmEvent): MotionEvent` — extracts motion-specific fields (ruleName, category)

### Modified file: `src/events/alarm-event-listener.ts`

- Remove `parseBaseEvent()` and `parseQueryString()` private methods
- Import `parseBaseEvent`, `parseQueryString`, `parseMotionEvent` from `./parse-event.js`
- `handleMessage()` calls the imported functions
- The MOTION case in `handleMessage()` calls `parseMotionEvent(base)` instead of inline construction

Note: `parseMotionEvent` is a new function (not an extraction) — it encapsulates the inline motion event construction currently in the `handleMessage` switch case (lines 127-131).

## Test Files

### 1. `src/config.test.ts`

Tests `loadConfig()` from `src/config.ts`.

**Mocks:** `vi.mock('node:fs', ...)` with factory (destructured imports require module-level mock, not `vi.spyOn`). Also `vi.spyOn(process, 'cwd')` to control config path resolution. Set `process.env` directly in each test (restore in `afterEach`).

**Test cases:**
- Valid YAML with all fields → returns complete config
- Missing YAML files → falls back to env vars (`ADC_USERNAME`, `ADC_PASSWORD`)
- Missing credentials in both file and env → throws error with descriptive message
- Partial config → merges with defaults (go2rtc defaults, logging defaults)
- Cameras array in config → passed through; non-array → defaults to empty
- `homebridge` section present → parsed with motionTimeoutMs default (60000)
- `homebridge` section absent → `undefined`
- `mfaToken` empty string in file → falls back to env var; env var empty → result is `undefined` (not `""`)
- Empty YAML file (file exists but content is empty) → `yaml.parse('')` returns `null` — this is a latent bug that tests should surface, fix in production code to handle `null`

### 2. `src/utils/retry.test.ts`

Tests `retry()` and `sleep()` from `src/utils/retry.ts`.

**Mocks:** `vi.useFakeTimers()` for timer control

**Test cases for `retry()`:**
- Function succeeds on first call → returns result, no delay
- Function fails once then succeeds → retries once, returns result
- Function fails all attempts → throws last error
- Function throws a non-Error value (string) → wrapped in Error
- Default max attempts is 3
- Custom max attempts respected
- Exponential backoff: delays are `baseDelay * 2^(attempt-1)`, capped at `maxDelay`
- Returned value type preserved (generic)

**Timer pattern:** Use `vi.useFakeTimers()` with `vi.advanceTimersByTimeAsync()` to avoid async deadlock.

**Test cases for `sleep()`:**
- Resolves after specified milliseconds

### 3. `src/events/parse-event.test.ts`

Tests `parseBaseEvent()`, `parseQueryString()`, and `parseMotionEvent()` from `src/events/parse-event.ts`.

**Mocks:** None (pure functions)

**Test cases for `parseBaseEvent()`:**
- Valid event JSON → correct `AlarmEvent` with all fields
- `cameraId` composed as `"${unitId}-${deviceId}"`
- Numeric fields coerced from string/number (`UnitId`, `DeviceId`, `EventType`, etc.)
- Missing `QstringForExtraData` → empty `extraData` object
- Null `CorrelatedId` → `null`
- Missing `CorrelatedId` (undefined) → `null`
- Missing fields → defaults (0 for numbers, empty string for strings)

**Test cases for `parseQueryString()`:**
- Standard query string → key-value pairs
- Keys without values → empty string value
- Empty string input → empty object
- URL-encoded values preserved (not decoded — caller decodes as needed)
- Duplicate keys → last value wins (documents current behavior)

**Test cases for `parseMotionEvent()`:**
- Extracts `ruleName` from `extraData.rn`, URL-decoded, `+` replaced with spaces
- Extracts `category` as number from `extraData.category`
- Missing `rn` → empty string
- Missing `category` → 0

### 4. `src/auth/alarm-auth.test.ts`

Tests `isSessionFresh()` from `AlarmAuth`.

**Mocks:** `vi.mock('node-alarm-dot-com', ...)` to mock `login()` and `authenticatedGet()`. Use mocked `login()` to establish session state before testing freshness.

**Test cases:**
- No auth (never logged in) → not fresh
- After `authenticate()` with mocked login, < 55 minutes ago → fresh
- After `authenticate()`, exactly 55 minutes ago → not fresh (use `vi.spyOn(Date, 'now')`)
- After `authenticate()`, > 55 minutes ago → not fresh
- After `destroy()` → not fresh

### 5. `src/go2rtc/go2rtc-api.test.ts`

Tests `Go2rtcApi` methods.

**Mocks:** `globalThis.fetch`

**Test cases for `isHealthy()`:**
- HTTP 200 → returns `true`
- HTTP 500 → returns `false`
- Network error (fetch throws) → returns `false`

**Test cases for `getStreams()`:**
- Returns parsed JSON body
- Non-OK HTTP response (500) → throws
- Network error → throws

**Test cases for `waitReady()`:**
- Already healthy → resolves immediately
- Becomes healthy after N polls → resolves
- Never healthy within timeout → throws

**Timer pattern:** `waitReady` uses `setTimeout` and `Date.now()` internally. Use `vi.useFakeTimers()` with `vi.advanceTimersByTimeAsync()` to control polling and timeout.

## File Summary

| File | Action |
|------|--------|
| `vitest.config.ts` | New — vitest configuration |
| `src/events/parse-event.ts` | New — extracted pure parsing functions |
| `src/events/alarm-event-listener.ts` | Modify — import from parse-event.ts |
| `src/config.test.ts` | New — config loading tests |
| `src/utils/retry.test.ts` | New — retry logic tests |
| `src/events/parse-event.test.ts` | New — event parsing tests |
| `src/auth/alarm-auth.test.ts` | New — session freshness tests |
| `src/go2rtc/go2rtc-api.test.ts` | New — go2rtc API client tests |

## Verification

1. `npm run build` compiles (refactored code still works)
2. `npm test` runs all tests and passes
3. No behavior change in production code (refactor only extracts, doesn't modify logic)

## Future expansion

Once this foundation is in place, the next rounds would cover:
- Token manager (timer coordination, token parsing)
- Camera manager (orchestration, event routing)
- Signaling client (state machine transitions)
- Motion webhook integration (debounce, timeout logic)
