import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

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
      fileConfig = parse(raw) as Partial<AppConfig>;
      break;
    }
  }

  const alarm = {
    username: fileConfig.alarm?.username || process.env.ADC_USERNAME || '',
    password: fileConfig.alarm?.password || process.env.ADC_PASSWORD || '',
    mfaToken: fileConfig.alarm?.mfaToken || process.env.ADC_MFA_TOKEN || undefined,
  };

  if (!alarm.username || !alarm.password) {
    throw new Error(
      'Alarm.com credentials required. Set in config.yaml or ADC_USERNAME/ADC_PASSWORD env vars.',
    );
  }

  return {
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
  };
}
