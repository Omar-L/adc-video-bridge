import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('go2rtc');

/**
 * Lightweight client for the go2rtc REST API.
 * Used for health checks and stream status monitoring.
 */
export class Go2rtcApi {
  constructor(private readonly baseUrl: string) {}

  /** Check if go2rtc is reachable. */
  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/streams`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Get the list of active streams. */
  async getStreams(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/api/streams`);
    if (!res.ok) throw new Error(`go2rtc API error: ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  }

  /** Wait for go2rtc to become available, with timeout. */
  async waitReady(timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.isHealthy()) {
        log.info('go2rtc is ready');
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`go2rtc not ready after ${timeoutMs}ms`);
  }
}
