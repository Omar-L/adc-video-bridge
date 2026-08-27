import { describe, it, expect, vi } from 'vitest';

const { MockWebSocket, getInstances } = vi.hoisted(() => {
  const { EventEmitter } = require('node:events');
  const instances: any[] = [];

  class MockWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;

    readyState = MockWebSocket.CONNECTING;
    send = vi.fn();

    constructor(public readonly url: string) {
      super();
      instances.push(this);
    }

    close(): void {
      queueMicrotask(() => {
        this.emit('error', new Error('WebSocket was closed before the connection was established'));
      });
    }
  }

  return {
    MockWebSocket,
    getInstances: () => instances,
  };
});

vi.mock('ws', () => ({ default: MockWebSocket }));

vi.mock('../utils/logger.js', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { SignalingClient } from './signaling-client.js';

describe('SignalingClient shutdown', () => {
  it('safely consumes the ws error caused by closing while CONNECTING', async () => {
    const client = new SignalingClient('guest-bedroom');
    const clientError = vi.fn();
    client.on('error', clientError);

    const connection = client.connect('wss://example.test', 'token', 'camera-token');
    expect(getInstances()).toHaveLength(1);

    client.close();

    await expect(connection).rejects.toThrow(
      'WebSocket was closed before the connection was established',
    );
    expect(clientError).not.toHaveBeenCalled();
  });
});
