import { EventType, type AlarmEvent, type MotionEvent } from './types.js';

/** Parse raw WebSocket JSON message into a typed AlarmEvent. */
export function parseBaseEvent(msg: Record<string, unknown>): AlarmEvent {
  const unitId = Number(msg.UnitId) || 0;
  const deviceId = Number(msg.DeviceId) || 0;
  const qstring = typeof msg.QstringForExtraData === 'string' ? msg.QstringForExtraData : '';

  return {
    eventDateUtc: String(msg.EventDateUtc ?? ''),
    unitId,
    deviceId,
    cameraId: `${unitId}-${deviceId}`,
    eventType: Number(msg.EventType) || 0,
    eventValue: Number(msg.EventValue) || 0,
    correlatedId: msg.CorrelatedId != null ? Number(msg.CorrelatedId) : null,
    extraData: parseQueryString(qstring),
    deviceType: Number(msg.DeviceType) || 0,
  };
}

/** Parse URL query string format (key=value&key2=value2) into key-value pairs. */
export function parseQueryString(qs: string): Record<string, string> {
  if (!qs) return {};
  const result: Record<string, string> = {};
  for (const pair of qs.split('&')) {
    const idx = pair.indexOf('=');
    if (idx === -1) {
      result[pair] = '';
    } else {
      result[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
  }
  return result;
}

/** Extract motion-specific fields from a base event. */
export function parseMotionEvent(base: AlarmEvent): MotionEvent {
  return {
    ...base,
    eventType: EventType.MOTION,
    ruleName: decodeURIComponent(base.extraData.rn ?? '').replace(/\+/g, ' '),
    category: Number(base.extraData.category) || 0,
  };
}
