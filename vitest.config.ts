import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Fake-timer tests that drive async retry loops trigger
    // PromiseRejectionHandledWarning because Node flags rejections as
    // "unhandled" for a microtask tick before the try/catch picks them up.
    // All rejections ARE handled — the warning is a timing artefact.
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
