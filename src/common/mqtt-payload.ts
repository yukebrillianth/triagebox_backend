import { z } from 'zod';

export const prioritySchema = z.enum(['RED', 'YELLOW', 'GREEN', 'BLACK']);

const TRIAGE_LEVEL_MAP = ['BLACK', 'RED', 'YELLOW', 'GREEN'] as const;

const confidenceSchema = z.number().transform((v) => {
  if (v > 1) return Math.min(v / 100, 1);
  if (v < 0) return 0;
  return v;
});

/*
 * Patient ids are `TB-` plus the card's UID in upper-case hex, and this is where
 * that becomes true. Applied on ingest rather than on the radio for two reasons.
 *
 * The prefix never varies, so putting it in the LoRa packet would pay three bytes
 * of airtime per reading, four times a minute per node, forever, to transmit a
 * constant. Same reasoning that keeps TB_PPG_FS_HZ a compile-time constant instead
 * of a wire field. It would also break the node's
 * _Static_assert(PN532_UID_MAX * 2 <= LORA_VITAL_RFID_MAX) -- that is 20 <= 20
 * with no slack, and the assert is there to stop a truncated id from attaching one
 * patient's vitals to another.
 *
 * IDEMPOTENT ON PURPOSE. Victim.rfid is @unique, so a second spelling of the same
 * card is a second patient. A retained message replayed after a restart, or a
 * station that one day starts sending the prefix itself, must not produce
 * TB-TB-04A2B3.
 *
 * Upper-casing is belt and braces: the node's hex is already upper (k_hex in the
 * STM32's main.c), but a hand-rolled mosquitto_pub is whatever someone typed, and
 * `tb-04a2b3` and `TB-04A2B3` are the same card.
 *
 * `T` cannot appear in hex, so a real UID can never be mistaken for an
 * already-prefixed id.
 *
 * The node's own LCD prints the same form -- see set_patient_id() in
 * ui/logic/ui_bindings.c. If one side changes, change both, or the operator reads
 * a different id off the device than the command post reads off the dashboard.
 */
export function normalizeRfid(raw: string): string | null {
  const t = raw.trim().toUpperCase();

  if (t === '') return null;
  return t.startsWith('TB-') ? t : `TB-${t}`;
}

const rfidSchema = z
  .union([z.string(), z.number(), z.null()])
  .transform((v) => (v === null || v === undefined ? null : normalizeRfid(String(v))));

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

/*
 * KEYS MAY BE ABSENT, AND ABSENT IS NOT ZERO. The station omits a key rather
 * than sending 0 whenever a value is unknown, because every zero here means
 * something clinical: hr 0 is a dead patient, spo2 0 is asphyxia, battery 0 is a
 * flat node. A sensor that is not ready and a fuel-gauge read that failed both
 * arrive as an absent key -- requiring them dropped every real vital with one
 * warn line.
 *
 * `priority` (or `triage_level`) stays mandatory: it drives triage, the KPIs and
 * the alerts, so a reading without one has nothing to say in this system. The
 * station suppresses those instead of publishing them.
 */
export const vitalSchema = z
  .object({
    victim_rfid: rfidSchema.optional(),
    hr: z.number().optional(),
    heart_rate: z.number().optional(),
    spo2: z.number().optional(),
    rr: z.number().optional(),
    respiratory_rate: z.number().optional(),
    bp_sys: z.number().nullable().optional(),
    bp_dia: z.number().nullable().optional(),
    battery: z.number().optional(),
    priority: prioritySchema.optional(),
    triage_level: z.number().int().min(0).max(3).optional(),
    confidence: confidenceSchema.optional(),
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
  .transform((raw) => {
    const priority =
      raw.priority ??
      (raw.triage_level !== undefined
        ? TRIAGE_LEVEL_MAP[raw.triage_level]
        : undefined)!;
    const ts = raw.ts ?? raw.timestamp;
    return {
      victim_rfid: raw.victim_rfid ?? null,
      hr: raw.hr ?? raw.heart_rate ?? null,
      spo2: raw.spo2 ?? null,
      rr: raw.rr ?? raw.respiratory_rate ?? null,
      bp_sys: raw.bp_sys ?? null,
      bp_dia: raw.bp_dia ?? null,
      battery: raw.battery ?? null,
      priority: priority as z.infer<typeof prioritySchema>,
      confidence: raw.confidence ?? null,
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

/*
 * Adoption announce. The ONE topic that does not require pre-registration -- an
 * unknown station is the whole point. `mac` is the identity because it is the
 * only field a station cannot change from its own configuration; everything else
 * is a suggestion an admin may override when adopting.
 */
export const announceSchema = z.object({
  station_id: z.string().min(1).max(64),
  mac: z.string().min(1).max(64),
  ip: z.string().max(64).optional(),
  firmware: z.string().max(64).optional(),
  node_count: z.number().int().min(1).max(255).optional(),
});

export type Priority = z.infer<typeof prioritySchema>;
export type VitalPayload = z.output<typeof vitalSchema>;
export type NodeStatusPayload = z.infer<typeof nodeStatusSchema>;
export type StationStatusPayload = z.infer<typeof stationStatusSchema>;
export type AnnouncePayload = z.infer<typeof announceSchema>;

export type ParsedTopic =
  | { kind: 'vital'; stationId: string; nodeId: string }
  | { kind: 'node_status'; stationId: string; nodeId: string }
  | { kind: 'station_status'; stationId: string }
  | { kind: 'announce'; stationId: string };

export function parseTopic(topic: string): ParsedTopic | null {
  const parts = topic.split('/');

  if (parts.length === 3 && parts[0] === 'triagebox' && parts[1]) {
    if (parts[2] === 'status') {
      return { kind: 'station_status', stationId: parts[1] };
    }
    if (parts[2] === 'announce') {
      return { kind: 'announce', stationId: parts[1] };
    }
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
if (
  _chk.data.confidence === null ||
  Math.abs(_chk.data.confidence - 0.91) > 1e-9 ||
  _chk.data.priority !== 'GREEN'
) {
  throw new Error('Vital binary-compat self-check value mismatch');
}
/*
 * The id rule, pinned where it is cheapest to notice a break: a numeric tag gets
 * the prefix, lower case is folded up, and an id that already carries the prefix
 * is left alone rather than gaining a second one. That last case is the one that
 * would silently split one patient into two rows.
 */
if (_chk.data.victim_rfid !== 'TB-3021') {
  throw new Error('RFID prefix self-check failed: ' + String(_chk.data.victim_rfid));
}
if (
  normalizeRfid('tb-04a2b3') !== 'TB-04A2B3' ||
  normalizeRfid('TB-04A2B3') !== 'TB-04A2B3' ||
  normalizeRfid('04a2b3') !== 'TB-04A2B3' ||
  normalizeRfid('  ') !== null
) {
  throw new Error('RFID normalize self-check failed');
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

/*
 * The sparsest shape the ESP32 station really emits: the gauge has not reported
 * yet (or its read failed), so no `battery`; no tag scanned yet, so no
 * `victim_rfid` key at all. This shape used to be rejected, which meant every
 * real vital was dropped -- so it is asserted here rather than left to an
 * integration test nobody runs without a board.
 */
const _station = vitalSchema.safeParse({
  hr: 118,
  spo2: 91,
  rr: 28,
  priority: 'RED',
  confidence: 0.87,
  packet_counter: 1421,
  device_status: 0,
});
if (!_station.success) {
  throw new Error('Vital station self-check failed: ' + _station.error.message);
}
if (
  _station.data.victim_rfid !== null ||
  _station.data.battery !== null ||
  _station.data.priority !== 'RED'
) {
  throw new Error('Vital station self-check value mismatch');
}

/* Absent must stay absent, never become 0: a fabricated zero is indistinguishable
 * from a measured one, and 0 hr / 0 spo2 / 0 battery all read as emergencies. */
const _sparse = vitalSchema.safeParse({ priority: 'BLACK' });
if (!_sparse.success) {
  throw new Error('Vital sparse self-check failed: ' + _sparse.error.message);
}
if (
  _sparse.data.hr !== null ||
  _sparse.data.spo2 !== null ||
  _sparse.data.rr !== null ||
  _sparse.data.confidence !== null
) {
  throw new Error('Vital sparse self-check must yield null, not 0');
}

/* Priority is the one field that stays mandatory. */
if (vitalSchema.safeParse({ hr: 90, spo2: 98, rr: 18 }).success) {
  throw new Error('Vital self-check: a vital without priority must be rejected');
}
if (vitalSchema.safeParse({ hr: '90', priority: 'RED' }).success) {
  throw new Error('Vital self-check: numbers as strings must be rejected');
}

/* Topic routing: announce must be recognised, and must not be mistaken for the
 * station status topic that sits at the same depth. */
const _announceTopic = parseTopic('triagebox/st-01/announce');
const _statusTopic = parseTopic('triagebox/st-01/status');
if (
  _announceTopic?.kind !== 'announce' ||
  _statusTopic?.kind !== 'station_status' ||
  parseTopic('triagebox/st-01/unknown') !== null
) {
  throw new Error('parseTopic self-check failed');
}
