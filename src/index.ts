import { loadConfig } from './config.js';
import { logger } from './utils/logger.js';
import { AlarmAuth } from './auth/alarm-auth.js';
import { TokenManager } from './auth/token-manager.js';
import { CameraManager } from './camera/camera-manager.js';
import { Go2rtcApi } from './go2rtc/go2rtc-api.js';

const log = logger.child({ component: 'main' });

async function main(): Promise<void> {
  log.info('adc-video-bridge starting');

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    log.fatal('Config error: %s', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  log.info({ cameraCount: config.cameras.length }, 'Config loaded');

  // Wait for go2rtc
  const go2rtc = new Go2rtcApi(config.go2rtc.apiUrl);
  try {
    await go2rtc.waitReady();
  } catch {
    log.warn('go2rtc not available — streams will fail until go2rtc starts');
  }

  // Initialize auth
  const auth = new AlarmAuth(
    config.alarm.username,
    config.alarm.password,
    config.alarm.mfaToken,
  );

  // Initialize token manager and camera manager
  const tokenManager = new TokenManager(auth);
  const rtspBaseUrl = `rtsp://127.0.0.1:${config.go2rtc.rtspPort}`;
  const cameraManager = new CameraManager(tokenManager, rtspBaseUrl);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutting down...');
    await cameraManager.stop();
    auth.destroy();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start streaming
  await cameraManager.start(config.cameras);

  // Periodic status logging
  setInterval(() => {
    const status = cameraManager.getStatus();
    log.info({ streams: status }, 'Stream status');
  }, 60_000);
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  log.fatal('Fatal error: %s', message);
  process.exit(1);
});
