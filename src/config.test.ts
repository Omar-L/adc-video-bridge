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
