import { describe, it, expect } from 'vitest';
import { parseQueryString, parseBaseEvent, parseMotionEvent } from './parse-event.js';

describe('parseQueryString', () => {
  it('parses standard key=value pairs', () => {
    expect(parseQueryString('a=1&b=2')).toEqual({ a: '1', b: '2' });
  });

  it('returns empty object for empty string', () => {
    expect(parseQueryString('')).toEqual({});
  });

  it('handles keys without values', () => {
    expect(parseQueryString('flagOnly')).toEqual({ flagOnly: '' });
  });

  it('preserves URL-encoded values (does not decode)', () => {
    expect(parseQueryString('rn=Driveway%20Analytics')).toEqual({ rn: 'Driveway%20Analytics' });
  });

  it('last value wins for duplicate keys', () => {
    expect(parseQueryString('a=1&a=2')).toEqual({ a: '2' });
  });

  it('handles values containing equals signs', () => {
    expect(parseQueryString('data=a=b')).toEqual({ data: 'a=b' });
  });
});

describe('parseBaseEvent', () => {
  it('parses a valid event message', () => {
    const msg = {
      EventDateUtc: '2026-03-27T17:07:33.09Z',
      UnitId: 100652375,
      DeviceId: 2048,
      EventType: 210,
      EventValue: 400001,
      CorrelatedId: 308762392372,
      QstringForExtraData: 'rn=Driveway+Video+Analytics&category=4',
      DeviceType: -1,
    };
    const event = parseBaseEvent(msg);
    expect(event.eventDateUtc).toBe('2026-03-27T17:07:33.09Z');
    expect(event.unitId).toBe(100652375);
    expect(event.deviceId).toBe(2048);
    expect(event.cameraId).toBe('100652375-2048');
    expect(event.eventType).toBe(210);
    expect(event.eventValue).toBe(400001);
    expect(event.correlatedId).toBe(308762392372);
    expect(event.extraData).toEqual({ rn: 'Driveway+Video+Analytics', category: '4' });
    expect(event.deviceType).toBe(-1);
  });

  it('composes cameraId from unitId and deviceId', () => {
    const event = parseBaseEvent({ UnitId: 123, DeviceId: 456 });
    expect(event.cameraId).toBe('123-456');
  });

  it('defaults missing numeric fields to 0', () => {
    const event = parseBaseEvent({});
    expect(event.unitId).toBe(0);
    expect(event.deviceId).toBe(0);
    expect(event.eventType).toBe(0);
    expect(event.eventValue).toBe(0);
    expect(event.deviceType).toBe(0);
  });

  it('defaults missing string fields to empty string', () => {
    const event = parseBaseEvent({});
    expect(event.eventDateUtc).toBe('');
  });

  it('maps null CorrelatedId to null', () => {
    const event = parseBaseEvent({ CorrelatedId: null });
    expect(event.correlatedId).toBeNull();
  });

  it('maps missing CorrelatedId (undefined) to null', () => {
    const event = parseBaseEvent({});
    expect(event.correlatedId).toBeNull();
  });

  it('handles missing QstringForExtraData', () => {
    const event = parseBaseEvent({});
    expect(event.extraData).toEqual({});
  });

  it('handles non-string QstringForExtraData', () => {
    const event = parseBaseEvent({ QstringForExtraData: 12345 });
    expect(event.extraData).toEqual({});
  });

  it('coerces string-typed numeric fields', () => {
    const event = parseBaseEvent({ UnitId: '100', DeviceId: '200', EventType: '210' });
    expect(event.unitId).toBe(100);
    expect(event.deviceId).toBe(200);
    expect(event.eventType).toBe(210);
  });
});

describe('parseMotionEvent', () => {
  it('extracts ruleName from URL-encoded rn field', () => {
    const base = parseBaseEvent({
      EventType: 210,
      QstringForExtraData: 'rn=Driveway+Video+Analytics&category=4',
    });
    const motion = parseMotionEvent(base);
    expect(motion.ruleName).toBe('Driveway Video Analytics');
    expect(motion.category).toBe(4);
    expect(motion.eventType).toBe(210);
  });

  it('handles URL-encoded rn with %20', () => {
    const base = parseBaseEvent({
      QstringForExtraData: 'rn=Back%20Patio%20Analytics&category=4',
    });
    const motion = parseMotionEvent(base);
    expect(motion.ruleName).toBe('Back Patio Analytics');
  });

  it('defaults missing rn to empty string', () => {
    const base = parseBaseEvent({ QstringForExtraData: 'category=4' });
    const motion = parseMotionEvent(base);
    expect(motion.ruleName).toBe('');
  });

  it('defaults missing category to 0', () => {
    const base = parseBaseEvent({ QstringForExtraData: 'rn=Test' });
    const motion = parseMotionEvent(base);
    expect(motion.category).toBe(0);
  });
});
