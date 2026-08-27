/*
 * Contract check: does the ESP32 station's real output still parse?
 *
 *   npm run check:station
 *
 * The station omits keys rather than sending zeros (hr 0 is a dead patient,
 * battery 0 is a flat node), so most of its payloads are sparse. Requiring those
 * fields silently dropped every vital from real hardware, which is the regression
 * this guards.
 *
 * The fixtures below are not hand-written: they are the verbatim stdout of
 * triagebox-station/main/tb_vital_json.c for six states the hardware actually
 * reaches. To regenerate after a firmware change, in the station repo:
 *
 *   gcc -I main -o /tmp/emit tools/emit_fixtures.c main/tb_vital_json.c && /tmp/emit
 *
 * Kept as frozen strings rather than a cross-repo build step so this repo stays
 * standalone.
 */
import { vitalSchema } from '../src/common/mqtt-payload';

/** [label, station JSON, must the backend accept it] */
const CASES: [string, string, boolean][] = [
  [
    'scored, gauge not read yet, no tag (first cycles after boot)',
    '{"hr":118,"spo2":91,"rr":28,"priority":"RED","confidence":0.87,"packet_counter":1421,"device_status":0}',
    true,
  ],
  [
    'scored, tag scanned, gauge read failed',
    '{"victim_rfid":"04A2B3","hr":118,"spo2":91,"rr":28,"priority":"RED","confidence":0.87,"packet_counter":1421,"device_status":0}',
    true,
  ],
  [
    'steady state: PMIC gauge + a synced clock (clock still future)',
    '{"victim_rfid":"04A2B3","hr":118,"spo2":91,"rr":28,"battery":76,"priority":"RED","confidence":0.87,"packet_counter":1421,"device_status":0,"ts":1755500000}',
    true,
  ],
  [
    'SpO2 sensor down, rest fine',
    '{"victim_rfid":"04A2B3","hr":118,"rr":28,"battery":76,"priority":"YELLOW","confidence":0.72,"packet_counter":1421,"device_status":0}',
    true,
  ],
  // Priority stays mandatory: it drives triage, the KPIs and the alerts, so the
  // station suppresses these two instead of publishing them.
  [
    'not yet scored',
    '{"hr":90,"spo2":98,"rr":18,"packet_counter":1421,"device_status":0}',
    false,
  ],
  [
    'no sensor ready at all',
    '{"packet_counter":1421,"device_status":0}',
    false,
  ],
];

/** Malformed payloads the relaxation must NOT have let through. */
const MUST_REJECT: [string, string][] = [
  ['priority out of enum', '{"hr":90,"priority":"PURPLE"}'],
  ['triage_level above 3', '{"hr":90,"triage_level":4}'],
  ['number sent as string', '{"hr":"90","priority":"RED"}'],
];

let failed = 0;

for (const [label, json, shouldAccept] of CASES) {
  const r = vitalSchema.safeParse(JSON.parse(json));
  if (r.success !== shouldAccept) {
    failed++;
    console.error(
      `FAIL  ${label}\n      expected ${shouldAccept ? 'accept' : 'reject'}, got ${
        r.success ? 'accept' : 'reject'
      }${r.success ? '' : `\n      ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`}`,
    );
    continue;
  }
  // An accepted sparse payload must yield null, never a fabricated 0.
  if (r.success) {
    const zeroed = (['hr', 'spo2', 'rr', 'battery', 'confidence'] as const).filter(
      (k) => !(k in JSON.parse(json)) && r.data[k] !== null,
    );
    if (zeroed.length > 0) {
      failed++;
      console.error(`FAIL  ${label}\n      absent keys became non-null: ${zeroed.join(', ')}`);
      continue;
    }
    // The station sends the bare card UID; the id a human ever sees is TB- plus
    // that, upper case. Checked here because the station is the only producer, so
    // this is where a firmware that started sending its own prefix would show up
    // as TB-TB-.
    const raw = JSON.parse(json).victim_rfid as string | undefined;
    const want = raw === undefined ? null : `TB-${raw.toUpperCase()}`;
    if (r.data.victim_rfid !== want) {
      failed++;
      console.error(
        `FAIL  ${label}\n      victim_rfid: got ${String(r.data.victim_rfid)}, want ${String(want)}`,
      );
      continue;
    }
  }
  console.log(`ok    ${shouldAccept ? 'accept' : 'reject'}  ${label}`);
}

for (const [label, json] of MUST_REJECT) {
  if (vitalSchema.safeParse(JSON.parse(json)).success) {
    failed++;
    console.error(`FAIL  ${label} was accepted but must be rejected`);
  } else {
    console.log(`ok    reject  ${label}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} station contract check(s) failed`);
  process.exit(1);
}
console.log('\nstation payload contract: all checks passed');
