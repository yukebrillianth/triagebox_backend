#!/usr/bin/env node
/**
 * Field-test recorder for the TriageBox radio link.
 *
 *   node scripts/field-test.js --label "50m LOS" --minutes 5
 *   node scripts/field-test.js --label "100m obstructed" --minutes 5 --out /tmp/fieldtest.csv
 *
 * Subscribes to the station's real traffic and records what a range/latency test
 * needs, per node: packet delivery ratio, RSSI, SNR, and the pipeline latency
 * from MQTT arrival to the reading being readable over REST.
 *
 * WHY THIS AND NOT A STOPWATCH. The two numbers that matter for the report are
 * PDR and latency, and both are easy to measure wrong. PDR is not "did anything
 * arrive" -- it is arrivals divided by EXPECTED arrivals, and the expected count
 * comes from the poll cadence, so a test that only counts what showed up always
 * reports 100%. Latency has to be split at the radio boundary or the LoRa cycle
 * (0-15s) buries the part the software controls (milliseconds), and reporting the
 * sum as one figure hides which half to improve.
 *
 * Run this on the machine hosting the broker. It changes nothing -- subscribe
 * only, no publishing.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mqtt = require(path.join(__dirname, '..', 'node_modules', 'mqtt'));

const LORA_PERIOD_MS = 15000; // LORA_POLL_PERIOD_MS in lora_poll.h

function parseArgs(argv) {
  const out = {
    label: 'untitled',
    minutes: 5,
    broker: process.env.MQTT_URL || 'mqtt://localhost:1883',
    api: process.env.API_URL || 'http://localhost:3001',
    out: '/tmp/triagebox-fieldtest.csv',
    period: LORA_PERIOD_MS,
  };
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[i + 1];
    if (v === undefined) break;
    out[k] = k === 'minutes' || k === 'period' ? Number(v) : v;
  }
  return out;
}

const args = parseArgs(process.argv);

/** Per node: counters and the RSSI/SNR series. */
const nodes = new Map();

function node(id) {
  if (!nodes.has(id)) {
    nodes.set(id, {
      vitals: 0,
      status: 0,
      rssi: [],
      snr: [],
      firstAt: null,
      lastAt: null,
      latencies: [],
      packetCounters: [],
    });
  }
  return nodes.get(id);
}

function stats(xs) {
  if (xs.length === 0) return { n: 0, min: null, max: null, mean: null, p95: null };
  const s = [...xs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: s[0],
    max: s[s.length - 1],
    mean: sum / s.length,
    p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))],
  };
}

/**
 * Pipeline latency: MQTT arrival -> readable over REST. Polls the victim's vitals
 * endpoint until the reading appears.
 *
 * This is the half the software owns. The other half -- the node waiting for its
 * poll -- is 0 to one full cycle and is a property of the protocol, not of any
 * code that could be made faster. Reporting them separately is the whole point.
 */
async function measurePipeline(rfid, arrivedAt) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${args.api}/api/victims`);
      if (res.ok) {
        const victims = await res.json();
        const v = victims.find((x) => x.rfid === rfid);
        if (v && Date.parse(v.lastUpdate) >= arrivedAt - 2000) {
          return Date.now() - arrivedAt;
        }
      }
    } catch {
      /* backend not up yet; the deadline ends this */
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

/**
 * Replies lost on the air, from the node's own transmit counter.
 *
 * `packet_counter` increments once per node transmit and wraps at 65535, so a
 * jump larger than 1 is a reply that never arrived rather than a patient that
 * stopped being measured. This is what separates a radio problem from a sensor
 * problem, which PDR alone cannot do.
 */
function countGaps(counters) {
  let gaps = 0;
  for (let i = 1; i < counters.length; i++) {
    const d = (counters[i] - counters[i - 1] + 65536) % 65536;
    if (d > 1) gaps += d - 1;
  }
  return gaps;
}

/* Self-check: the wrap and the "no gap" case are both easy to get wrong, and a
 * wrong gap count would be reported as a radio problem that does not exist. */
if (countGaps([1, 2, 3]) !== 0) throw new Error('countGaps: consecutive must be 0');
if (countGaps([1, 4]) !== 2) throw new Error('countGaps: 1->4 must be 2');
if (countGaps([65534, 65535, 0, 1]) !== 0) throw new Error('countGaps: wrap must be 0');
if (countGaps([65534, 1]) !== 2) throw new Error('countGaps: wrap with loss must be 2');
if (countGaps([]) !== 0 || countGaps([7]) !== 0) throw new Error('countGaps: short input');

const client = mqtt.connect(args.broker, { clientId: `tb-fieldtest-${Date.now()}` });
const startedAt = Date.now();
let vitalTotal = 0;
let statusTotal = 0;

client.on('connect', () => {
  client.subscribe(['triagebox/+/+/vital', 'triagebox/+/+/status'], (err) => {
    if (err) {
      console.error('subscribe failed:', err.message);
      process.exit(1);
    }
    console.log(`=== TriageBox field test: ${args.label} ===`);
    console.log(`broker ${args.broker}  api ${args.api}`);
    console.log(`recording ${args.minutes} min, expecting one vital per node per ${args.period / 1000}s`);
    console.log('Ctrl-C stops early and still writes the report.\n');
  });
});

client.on('message', (topic, buf) => {
  const parts = topic.split('/');
  const nodeId = parts[2];
  const leaf = parts[3];
  const now = Date.now();
  let json;
  try {
    json = JSON.parse(buf.toString('utf-8'));
  } catch {
    return;
  }
  const n = node(nodeId);
  n.lastAt = now;
  if (n.firstAt === null) n.firstAt = now;

  if (leaf === 'vital') {
    n.vitals++;
    vitalTotal++;
    if (typeof json.packet_counter === 'number') {
      n.packetCounters.push(json.packet_counter);
    }
    if (json.victim_rfid != null && String(json.victim_rfid) !== '') {
      // Only sampled when a tag is present: without one the backend creates no
      // victim, so there is nothing to poll for.
      void measurePipeline(String(json.victim_rfid), now).then((ms) => {
        if (ms !== null) n.latencies.push(ms);
      });
    }
    process.stdout.write(`\rvitals ${vitalTotal}  status ${statusTotal}  nodes ${nodes.size}   `);
  } else if (leaf === 'status') {
    n.status++;
    statusTotal++;
    if (typeof json.rssi === 'number') n.rssi.push(json.rssi);
    if (typeof json.snr === 'number') n.snr.push(json.snr);
    process.stdout.write(`\rvitals ${vitalTotal}  status ${statusTotal}  nodes ${nodes.size}   `);
  }
});

function report() {
  const elapsedMs = Date.now() - startedAt;
  /* Expected arrivals per node: one per poll cycle over the window. Counting only
   * what arrived would always report 100% delivery, which is the mistake this
   * denominator exists to prevent. */
  const expected = Math.floor(elapsedMs / args.period);

  const rows = [];
  const header = [
    'label',
    'node',
    'elapsed_s',
    'expected',
    'vitals_rx',
    'pdr_pct',
    'gaps_from_counter',
    'rssi_mean',
    'rssi_min',
    'snr_mean',
    'snr_min',
    'pipeline_ms_mean',
    'pipeline_ms_p95',
  ];

  console.log(`\n\n=== ${args.label} -- ${(elapsedMs / 1000).toFixed(0)}s, expected ${expected} vitals per node ===\n`);
  if (nodes.size === 0) {
    console.log('No traffic. Check the station is powered, the broker URI matches,');
    console.log('and that this machine is the one the station publishes to.');
  }

  for (const [id, n] of [...nodes.entries()].sort()) {
    const pdr = expected > 0 ? (n.vitals / expected) * 100 : 0;
    const gaps = countGaps(n.packetCounters);
    const r = stats(n.rssi);
    const s = stats(n.snr);
    const l = stats(n.latencies);

    const fmt = (x, d = 1) => (x === null ? '-' : x.toFixed(d));
    console.log(
      `${id.padEnd(10)} PDR ${pdr.toFixed(1).padStart(5)}%  (${n.vitals}/${expected})` +
        `  gaps ${String(gaps).padStart(3)}` +
        `  RSSI ${fmt(r.mean).padStart(7)} dBm (worst ${fmt(r.min)})` +
        `  SNR ${fmt(s.mean).padStart(5)} dB (worst ${fmt(s.min)})` +
        `  pipeline ${fmt(l.mean, 0).padStart(4)} ms (p95 ${fmt(l.p95, 0)})`
    );

    rows.push([
      args.label,
      id,
      (elapsedMs / 1000).toFixed(0),
      expected,
      n.vitals,
      pdr.toFixed(1),
      gaps,
      fmt(r.mean),
      fmt(r.min),
      fmt(s.mean),
      fmt(s.min),
      fmt(l.mean, 0),
      fmt(l.p95, 0),
    ]);
  }

  const csv = [header, ...rows].map((r) => r.join(',')).join('\n') + '\n';
  const exists = fs.existsSync(args.out);
  fs.appendFileSync(args.out, exists ? csv.split('\n').slice(1).join('\n') : csv);
  console.log(`\nAppended ${rows.length} row(s) to ${args.out}`);
  console.log('Run again at each distance with a different --label; the CSV accumulates.');
  console.log('\nREAD IT LIKE THIS:');
  console.log('  PDR       the headline number. Below ~90% the link is not usable for triage.');
  console.log('  SNR worst closer to the SF7 demodulator floor of -7.5 dB = closer to dropping out.');
  console.log('  gaps      lost on the air. High gaps with high PDR means a marginal link, not a dead one.');
  console.log('  pipeline  MQTT arrival to readable over REST. The LoRa wait (0-15 s) is NOT in this.');
}

let done = false;
function finish(code) {
  if (done) return;
  done = true;
  report();
  client.end(true, () => process.exit(code));
}

setTimeout(() => finish(0), args.minutes * 60 * 1000);
process.on('SIGINT', () => finish(0));
client.on('error', (err) => {
  console.error(`\nmqtt: cannot reach ${args.broker}${err.message ? ` (${err.message})` : ''}`);
  console.error('Start the broker (docker compose up -d) or pass --broker mqtt://HOST:1883.');
  finish(1);
});

