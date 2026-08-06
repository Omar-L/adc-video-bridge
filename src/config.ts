import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const CAMERA_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CAMERA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

export interface CameraConfig {
  id: string;
  name: string;
  homebridgeName?: string;
  quality: 'hd' | 'sd';
}

export interface HomebridgeConfig {
  motionUrl: string;
  motionTimeoutMs: number;
}

export interface AppConfig {
  alarm: {
    username: string;
    password: string;
    mfaToken?: string;
  };
  cameras: CameraConfig[];
  go2rtc: {
    apiUrl: string;
    rtspPort: number;
  };
  homebridge?: HomebridgeConfig;
  logging: {
    level: string;
  };
}

const DEFAULT_CONFIG: Omit<AppConfig, 'alarm'> = {
  cameras: [],
  go2rtc: {
    apiUrl: 'http://localhost:1984',
    rtspPort: 8554,
  },
  logging: {
    level: 'info',
  },
};

function readEnvironmentSecret(name: string): string | undefined {
  const direct = process.env[name]?.trim();
  if (direct) return direct;

  const filePath = process.env[`${name}_FILE`]?.trim();
  if (!filePath) return undefined;

  try {
    const value = readFileSync(filePath, 'utf-8').trim();
    if (!value) throw new Error('file is empty');
    return value;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Unable to read ${name}_FILE: ${message}`);
  }
}

function validateHttpUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTP or HTTPS URL.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must use HTTP or HTTPS.`);
  }

  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

function validateConfig(config: AppConfig): AppConfig {
  if (!Number.isInteger(config.go2rtc.rtspPort) || config.go2rtc.rtspPort < 1 || config.go2rtc.rtspPort > 65_535) {
    throw new Error('go2rtc.rtspPort must be an integer between 1 and 65535.');
  }

  config.go2rtc.apiUrl = validateHttpUrl(config.go2rtc.apiUrl, 'go2rtc.apiUrl');

  if (!LOG_LEVELS.has(config.logging.level)) {
    throw new Error(`logging.level must be one of: ${[...LOG_LEVELS].join(', ')}.`);
  }

  const ids = new Set<string>();
  const names = new Set<string>();
  for (const camera of config.cameras) {
    if (!CAMERA_ID_PATTERN.test(camera.id)) {
      throw new Error(`Camera ID ${JSON.stringify(camera.id)} contains unsupported characters.`);
    }
    if (!CAMERA_NAME_PATTERN.test(camera.name)) {
      throw new Error(
        `Camera name ${JSON.stringify(camera.name)} must start with a lowercase letter or digit and contain only lowercase letters, digits, underscores, or hyphens.`,
      );
    }
    if (camera.quality !== 'hd' && camera.quality !== 'sd') {
      throw new Error(`Camera ${camera.name} quality must be "hd" or "sd".`);
    }
    if (ids.has(camera.id)) throw new Error(`Duplicate camera ID: ${camera.id}.`);
    if (names.has(camera.name)) throw new Error(`Duplicate camera name: ${camera.name}.`);
    ids.add(camera.id);
    names.add(camera.name);
  }

  if (config.homebridge) {
    config.homebridge.motionUrl = validateHttpUrl(
      config.homebridge.motionUrl,
      'homebridge.motionUrl',
    );
    if (!Number.isInteger(config.homebridge.motionTimeoutMs) || config.homebridge.motionTimeoutMs < 1_000) {
      throw new Error('homebridge.motionTimeoutMs must be an integer of at least 1000 milliseconds.');
    }
  }

  return config;
}

/**
 * Load config from YAML file, falling back to environment variables.
 * Config file is searched at: ./config/config.yaml, then ./config.yaml
 */
export function loadConfig(): AppConfig {
  const configPaths = [
    resolve(process.cwd(), 'config', 'config.yaml'),
    resolve(process.cwd(), 'config.yaml'),
  ];

  let fileConfig: Partial<AppConfig> = {};

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf-8');
      fileConfig = (parse(raw) as Partial<AppConfig>) ?? {};
      break;
    }
  }

  const alarm = {
    // Environment or Docker secret files take precedence so production
    // credentials never need to live in the mounted YAML configuration.
    username: readEnvironmentSecret('ADC_USERNAME') || fileConfig.alarm?.username || '',
    password: readEnvironmentSecret('ADC_PASSWORD') || fileConfig.alarm?.password || '',
    mfaToken:
      readEnvironmentSecret('ADC_MFA_TOKEN') || fileConfig.alarm?.mfaToken || undefined,
  };

  if (!alarm.username || !alarm.password) {
    throw new Error(
      'Alarm.com credentials required. Set in config.yaml or ADC_USERNAME/ADC_PASSWORD env vars.',
    );
  }

  return validateConfig({
    alarm,
    cameras: Array.isArray(fileConfig.cameras) ? fileConfig.cameras : DEFAULT_CONFIG.cameras,
    go2rtc: { ...DEFAULT_CONFIG.go2rtc, ...fileConfig.go2rtc },
    homebridge: fileConfig.homebridge
      ? {
          motionUrl: fileConfig.homebridge.motionUrl,
          motionTimeoutMs: fileConfig.homebridge.motionTimeoutMs ?? 60_000,
        }
      : undefined,
    logging: { ...DEFAULT_CONFIG.logging, ...fileConfig.logging },
  });
}
