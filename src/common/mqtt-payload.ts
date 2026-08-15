import { z } from 'zod';

export const prioritySchema = z.enum(['RED', 'YELLOW', 'GREEN', 'BLACK']);

const TRIAGE_LEVEL_MAP = ['BLACK', 'RED', 'YELLOW', 'GREEN'] as const;

const confidenceSchema = z.number().transform((v) => {
  if (v > 1) return Math.min(v / 100, 1);
  if (v < 0) return 0;
  return v;
});

const rfidSchema = z
  .union([z.string(), z.number(), z.null()])
  .transform((v) => (v === null || v === undefined ? null : String(v)));

export function parseDeviceTs(ts?: string | number | null): Date | null {
  if (ts === undefined || ts === null || ts === '') return null;
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    const ms = ts < 1e12 ? ts * 1000 : ts;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(String(ts));
  return Number.isNaN(d.getTime()) ? null : d;
}

export const vitalSchema = z
  .object({
    victim_rfid: rfidSchema,
    hr: z.number().optional(),
    heart_rate: z.number().optional(),
    spo2: z.number(),
    rr: z.number().optional(),
    respiratory_rate: z.number().optional(),
    bp_sys: z.number().nullable().optional(),
    bp_dia: z.number().nullable().optional(),
    battery: z.number(),
    priority: prioritySchema.optional(),
    triage_level: z.number().int().min(0).max(3).optional(),
    confidence: confidenceSchema,
    reasons: z.array(z.string()).default([]),
    ts: z.union([z.string(), z.number()]).optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    ecg_status: z.union([z.string(), z.number()]).optional(),
    device_status: z.union([z.string(), z.number()]).optional(),
    packet_counter: z.number().int().optional(),
    packet_version: z.number().int().optional(),
  })
  .refine(
    (raw) =>
      raw.priority !== undefined ||
      (raw.triage_level !== undefined &&
        raw.triage_level >= 0 &&
        raw.triage_level <= 3),
    { message: 'priority or triage_level required', path: ['priority'] },
  )
  .refine(
    (raw) => (raw.hr ?? raw.heart_rate) !== undefined,
    { message: 'hr or heart_rate required', path: ['hr'] },
  )
  .refine(
    (raw) => (raw.rr ?? raw.respiratory_rate) !== undefined,
    { message: 'rr or respiratory_rate required', path: ['rr'] },
  )
  .transform((raw) => {
    const priority =
      raw.priority ??
      (raw.triage_level !== undefined
        ? TRIAGE_LEVEL_MAP[raw.triage_level]
        : undefined)!;
    const hr = (raw.hr ?? raw.heart_rate)!;
    const rr = (raw.rr ?? raw.respiratory_rate)!;
    const ts = raw.ts ?? raw.timestamp;
    return {
      victim_rfid: raw.victim_rfid,
      hr,
      spo2: raw.spo2,
      rr,
      bp_sys: raw.bp_sys ?? null,
      bp_dia: raw.bp_dia ?? null,
      battery: raw.battery,
      priority: priority as z.infer<typeof prioritySchema>,
      confidence: raw.confidence,
      reasons: raw.reasons ?? [],
      ts,
      ecg_status:
        raw.ecg_status === undefined || raw.ecg_status === null
          ? null
          : String(raw.ecg_status),
      device_status:
        raw.device_status === undefined || raw.device_status === null
          ? null
          : String(raw.device_status),
      packet_counter: raw.packet_counter,
      packet_version: raw.packet_version,
    };
  });

export const nodeStatusSchema = z.object({
  status: z.enum(['ONLINE', 'OFFLINE']),
  rssi: z.number().optional(),
  snr: z.number().optional(),
  battery: z.number().optional(),
  firmware: z.string().optional(),
  packet_count: z.number().optional(),
  packet_counter: z.number().optional(),
});

export const stationStatusSchema = z.object({
  status: z.enum(['ONLINE', 'OFFLINE']),
});

export type Priority = z.infer<typeof prioritySchema>;
export type VitalPayload = z.output<typeof vitalSchema>;
export type NodeStatusPayload = z.infer<typeof nodeStatusSchema>;
export type StationStatusPayload = z.infer<typeof stationStatusSchema>;

export type ParsedTopic =
  | { kind: 'vital'; stationId: string; nodeId: string }
  | { kind: 'node_status'; stationId: string; nodeId: string }
  | { kind: 'station_status'; stationId: string };

export function parseTopic(topic: string): ParsedTopic | null {
  const parts = topic.split('/');

  if (parts.length === 3 && parts[0] === 'triagebox' && parts[1] && parts[2] === 'status') {
    return { kind: 'station_status', stationId: parts[1] };
  }

  if (
    parts.length === 4 &&
    parts[0] === 'triagebox' &&
    parts[1] &&
    parts[2] &&
    (parts[3] === 'vital' || parts[3] === 'status')
  ) {
    return {
      kind: parts[3] === 'vital' ? 'vital' : 'node_status',
      stationId: parts[1],
      nodeId: parts[2],
    };
  }

  return null;
}

if (!prioritySchema.safeParse('GREEN').success || prioritySchema.safeParse('PURPLE').success) {
  throw new Error('Priority schema self-check failed');
}
const _chk = vitalSchema.safeParse({
  victim_rfid: 3021,
  heart_rate: 90,
  spo2: 98,
  respiratory_rate: 18,
  battery: 80,
  triage_level: 3,
  confidence: 91,
  reasons: [],
  timestamp: 1720000000,
});
if (!_chk.success) {
  throw new Error('Vital binary-compat self-check failed: ' + _chk.error.message);
}
if (Math.abs(_chk.data.confidence - 0.91) > 1e-9 || _chk.data.priority !== 'GREEN') {
  throw new Error('Vital binary-compat self-check value mismatch');
}
const _legacy = vitalSchema.safeParse({
  victim_rfid: '3021',
  hr: 90,
  spo2: 98,
  rr: 18,
  battery: 80,
  priority: 'GREEN',
  confidence: 0.9,
  reasons: [],
  ts: '2026-07-25T00:00:00.000Z',
});
if (!_legacy.success) {
  throw new Error('Vital legacy self-check failed: ' + _legacy.error.message);
}
