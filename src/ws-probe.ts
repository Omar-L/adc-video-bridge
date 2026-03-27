import WebSocket from 'ws';
import { loadConfig } from './config.js';
import { AlarmAuth } from './auth/alarm-auth.js';

const WS_TOKEN_URL = 'https://www.alarm.com/web/api/websockets/token';
const WS_URL = 'wss://webskt.alarm.com:8443';

async function main(): Promise<void> {
  const config = loadConfig();
  const auth = new AlarmAuth(config.alarm.username, config.alarm.password, config.alarm.mfaToken);

  console.log('Logging in to Alarm.com...');
  await auth.authenticate();

  console.log('Fetching WebSocket token...');
  const tokenResponse = await auth.get<any>(WS_TOKEN_URL);
  console.log('Token response:', JSON.stringify(tokenResponse, null, 2));

  const token = tokenResponse?.value;
  const endpoint = tokenResponse?.metaData?.endpoint ?? WS_URL;

  if (!token) {
    console.error('Could not extract token from response. See raw response above.');
    auth.destroy();
    process.exit(1);
  }

  const wsUrl = `${endpoint}?auth=${token}`;
  console.log(`\nConnecting to ${endpoint}...`);

  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('WebSocket connected. Listening for events (Ctrl+C to stop)...\n');
  });

  ws.on('message', (data) => {
    const raw = data.toString();
    try {
      const parsed = JSON.parse(raw);
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}]`, JSON.stringify(parsed, null, 2));
    } catch {
      console.log(`[${new Date().toISOString()}] (raw)`, raw);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });

  ws.on('close', (code, reason) => {
    console.log(`WebSocket closed: code=${code} reason=${reason.toString()}`);
    auth.destroy();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    ws.close();
    auth.destroy();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
