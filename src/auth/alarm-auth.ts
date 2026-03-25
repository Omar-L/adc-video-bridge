import { login, authenticatedGet, type AuthOpts } from 'node-alarm-dot-com';
import { createChildLogger } from '../utils/logger.js';
import { retry } from '../utils/retry.js';
import type { CameraSummary } from '../types.js';

const log = createChildLogger('alarm-auth');

const CAMERAS_URL = 'https://www.alarm.com/web/api/video/devices/cameras';

/**
 * Manages an authenticated Alarm.com session.
 * Wraps node-alarm-dot-com's login and provides camera-specific API calls.
 */
export class AlarmAuth {
  private auth: AuthOpts | null = null;
  private lastLoginAt = 0;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly mfaToken?: string,
  ) {}

  /** Get current auth, logging in if needed. */
  async getAuth(): Promise<AuthOpts> {
    if (!this.auth) {
      await this.authenticate();
    }
    return this.auth!;
  }

  /** Force a fresh login. */
  async authenticate(): Promise<void> {
    log.info('Logging in to Alarm.com...');
    this.auth = await retry(
      () => login(this.username, this.password, this.mfaToken),
      { maxAttempts: 3, label: 'login' },
    );
    this.lastLoginAt = Date.now();
    log.info({ systems: this.auth.systems }, 'Login successful');
  }

  /** Check if session is likely still valid (logged in < 55 minutes ago). */
  isSessionFresh(): boolean {
    const SESSION_MAX_AGE_MS = 55 * 60 * 1000;
    return this.auth !== null && Date.now() - this.lastLoginAt < SESSION_MAX_AGE_MS;
  }

  /** Make an authenticated GET request. Re-authenticates on 401/403. */
  async get<T = unknown>(url: string): Promise<T> {
    const auth = await this.getAuth();
    try {
      return await authenticatedGet(url, auth);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('401') || message.includes('403')) {
        log.warn('Session expired, re-authenticating...');
        await this.authenticate();
        return await authenticatedGet(url, this.auth!);
      }
      throw err;
    }
  }

  /** Discover all cameras on the account. */
  async getCameraList(): Promise<CameraSummary[]> {
    log.debug('Fetching camera list...');
    const body: any = await this.get(CAMERAS_URL);
    const data = Array.isArray(body.data) ? body.data : [body.data];

    return data.map((cam: any) => ({
      id: cam.id,
      description: cam.attributes?.description ?? '',
      deviceModel: cam.attributes?.deviceModel ?? '',
      privateIp: cam.attributes?.privateIp ?? '',
      publicIp: cam.attributes?.publicIp ?? '',
      supportsLiveView: cam.attributes?.supportsLiveView ?? false,
      macAddress: cam.attributes?.macAddress ?? '',
    }));
  }

  /** Tear down the session. */
  destroy(): void {
    this.auth = null;
    this.lastLoginAt = 0;
  }
}
