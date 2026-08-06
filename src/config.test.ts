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
    delete process.env.ADC_USERNAME_FILE;
    delete process.env.ADC_PASSWORD_FILE;
    delete process.env.ADC_MFA_TOKEN_FILE;
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

  it('prefers environment credentials over YAML credentials', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`
alarm:
  username: "file@test.com"
  password: "filepass"
`);
    process.env.ADC_USERNAME = 'env@test.com';
    process.env.ADC_PASSWORD = 'envpass';

    const config = loadConfig();
    expect(config.alarm.username).toBe('env@test.com');
    expect(config.alarm.password).toBe('envpass');
  });

  it('loads credentials from Docker secret files', () => {
    process.env.ADC_USERNAME_FILE = '/run/secrets/adc_username';
    process.env.ADC_PASSWORD_FILE = '/run/secrets/adc_password';
    mockReadFileSync.mockImplementation((path) =>
      String(path).endsWith('adc_username') ? 'secret@test.com\n' : 'secret-password\n',
    );

    const config = loadConfig();
    expect(config.alarm.username).toBe('secret@test.com');
    expect(config.alarm.password).toBe('secret-password');
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

  it('rejects unsafe camera stream names', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`
cameras:
  - id: "123-456"
    name: "../front"
    quality: "hd"
`);
    process.env.ADC_USERNAME = 'u';
    process.env.ADC_PASSWORD = 'p';

    expect(() => loadConfig()).toThrow('Camera name');
  });

  it('rejects duplicate camera IDs', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`
cameras:
  - id: "123-456"
    name: "front"
    quality: "hd"
  - id: "123-456"
    name: "rear"
    quality: "hd"
`);
    process.env.ADC_USERNAME = 'u';
    process.env.ADC_PASSWORD = 'p';

    expect(() => loadConfig()).toThrow('Duplicate camera ID');
  });

  it('rejects non-HTTP Homebridge webhook URLs', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`
homebridge:
  motionUrl: "file:///tmp/hook"
`);
    process.env.ADC_USERNAME = 'u';
    process.env.ADC_PASSWORD = 'p';

    expect(() => loadConfig()).toThrow('homebridge.motionUrl must use HTTP or HTTPS');
  });
});
