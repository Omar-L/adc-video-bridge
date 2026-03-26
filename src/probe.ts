import { loadConfig } from './config.js';
import { AlarmAuth } from './auth/alarm-auth.js';

const VIDEO_SOURCE_URL =
  'https://www.alarm.com/web/api/video/videoSources/liveVideoHighestResSources/';

async function main(): Promise<void> {
  const cameraId = process.argv[2];
  if (!cameraId) {
    console.error('Usage: tsx src/probe.ts <camera-id>');
    console.error('  Fetches the raw video source API response for a camera/doorbell.');
    console.error('  Run "npm run discover" first to find camera IDs.');
    process.exit(1);
  }

  const config = loadConfig();
  const auth = new AlarmAuth(config.alarm.username, config.alarm.password, config.alarm.mfaToken);

  console.log('Logging in to Alarm.com...');
  await auth.authenticate();

  console.log(`Fetching video source for camera ${cameraId}...\n`);
  try {
    const response = await auth.get(VIDEO_SOURCE_URL + cameraId);
    console.log(JSON.stringify(response, null, 2));
  } catch (err) {
    console.error('API call failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  auth.destroy();
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
