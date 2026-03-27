export const EventType = {
  SENSOR_CHANGE: 15,
  LOGIN: 55,
  VIDEO_CLIP: 71,
  LOCK: 90,
  PANEL: 100,
  MOTION: 210,
  MOTION_END: 576,
} as const;

export interface AlarmEvent {
  eventDateUtc: string;
  unitId: number;
  deviceId: number;
  /** Composite ID: "${unitId}-${deviceId}" */
  cameraId: string;
  eventType: number;
  eventValue: number;
  correlatedId: number | null;
  extraData: Record<string, string>;
  deviceType: number;
}

export interface MotionEvent extends AlarmEvent {
  eventType: typeof EventType.MOTION;
  ruleName: string;
  category: number;
}

export interface MotionEndEvent extends AlarmEvent {
  eventType: typeof EventType.MOTION_END;
}

export interface ClipEvent extends AlarmEvent {
  eventType: typeof EventType.VIDEO_CLIP;
}

export interface SensorEvent extends AlarmEvent {
  eventType: typeof EventType.SENSOR_CHANGE;
}

export interface AlarmEventListenerEvents {
  motion: (event: MotionEvent) => void;
  motionEnd: (event: MotionEndEvent) => void;
  clipRecorded: (event: ClipEvent) => void;
  sensorChange: (event: SensorEvent) => void;
  raw: (event: AlarmEvent) => void;
  error: (error: Error) => void;
}
