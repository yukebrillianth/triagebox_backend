#!/usr/bin/env node
/**
 * TriageBox Node Simulator - scripted earthquake scenario.
 *
 * IDs (align with seed T15):
 *   stations: st-01 .. st-N
 *   nodes:    node-01 .. node-(N*M)  - M nodes per station, sequential
 *             e.g. --stations 2 --nodes 5 → st-01/node-01..05, st-02/node-06..10
 *
 * Nodes MUST be pre-registered. Run seed (T15) or create via REST first.
 * Reminder printed on startup.
 *
 * Usage:
 *   node simulator/index.js --stations 2 --nodes 5 --duration 90 --speed 10
 *   node simulator/index.js --stations 2 --nodes 5 --duration 30 --speed 20 [--broker mqtt://localhost:1883] [--rfid-offset 0]
 */
"use strict";

const path = require("path");

// Prefer local/parent node_modules (simulator has no own package.json)
function requireMqtt() {
  try {
    return require("mqtt");
  } catch {
    return require(path.join(__dirname, "..", "node_modules", "mqtt"));
  }
}

const mqttLib = requireMqtt();

function parseArgs(argv) {
  const out = {
    stations: 2,
    nodes: 5,
    duration: 90,
    speed: 10,
    broker: process.env.MQTT_URL || "mqtt://localhost:1883",
    rfidOffset: 0,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--stations")
      out.stations = Math.max(1, parseInt(next(), 10) || 1);
    else if (a === "--nodes")
      out.nodes = Math.max(1, parseInt(next(), 10) || 1);
    else if (a === "--duration")
      out.duration = Math.max(1, parseInt(next(), 10) || 1);
    else if (a === "--speed")
      out.speed = Math.max(0.1, parseFloat(next()) || 1);
    else if (a === "--broker") out.broker = next();
    else if (a === "--rfid-offset") out.rfidOffset = parseInt(next(), 10) || 0;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: node simulator/index.js [flags]
  --stations N       number of stations (default 2)
  --nodes M          nodes per station (default 5)
  --duration SEC     wall-clock run seconds (default 90)
  --speed X          scenario time multiplier (default 10)
  --broker URL       MQTT broker (default mqtt://localhost:1883)
  --rfid-offset N    add to RFID base for re-runs (default 0)

IDs: st-01..st-N, node-01..node-(N*M) sequential across stations.
PRE-REGISTER nodes (npm run seed or REST). Unknown ids are dropped by backend.`);
      process.exit(0);
    }
  }
  return out;
}

function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}

function stationId(i) {
  return `st-${pad(i)}`;
}

function nodeId(n) {
  return `node-${pad(n)}`;
}

/** Build flat node list: station s (1-based) owns nodes (s-1)*M+1 .. s*M */
function buildTopology(numStations, nodesPerStation) {
  const stations = [];
  const nodes = [];
  for (let s = 1; s <= numStations; s++) {
    const sid = stationId(s);
    stations.push(sid);
    for (let m = 1; m <= nodesPerStation; m++) {
      const global = (s - 1) * nodesPerStation + m;
      nodes.push({
        stationId: sid,
        nodeId: nodeId(global),
        index: global - 1,
      });
    }
  }
  return { stations, nodes };
}

function jitter(base, pct = 0.05) {
  const d = base * pct;
  return base + (Math.random() * 2 - 1) * d;
}

function round(n, digits = 0) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Vital ranges by priority (realistic) */
function vitalsFor(priority) {
  switch (priority) {
    case "RED":
      return {
        hr: round(jitter(140, 0.08)),
        spo2: round(jitter(86, 0.04)),
        rr: round(jitter(28, 0.1)),
        bp_sys: round(jitter(90, 0.08)),
        bp_dia: round(jitter(55, 0.08)),
        confidence: round(0.85 + Math.random() * 0.14, 2),
        reasons: ["HR>130", "SpO2<90"],
      };
    case "YELLOW":
      return {
        hr: round(jitter(110, 0.08)),
        spo2: round(jitter(93, 0.03)),
        rr: round(jitter(22, 0.1)),
        bp_sys: round(jitter(105, 0.06)),
        bp_dia: round(jitter(68, 0.06)),
        confidence: round(0.75 + Math.random() * 0.15, 2),
        reasons: ["HR>100"],
      };
    case "BLACK":
      return {
        hr: round(jitter(0, 0)),
        spo2: round(jitter(0, 0)),
        rr: round(jitter(0, 0)),
        bp_sys: null,
        bp_dia: null,
        confidence: round(0.9 + Math.random() * 0.09, 2),
        reasons: ["no_vitals"],
      };
    case "GREEN":
    default:
      return {
        hr: round(jitter(78, 0.1)),
        spo2: round(jitter(98, 0.015)),
        rr: round(jitter(16, 0.1)),
        bp_sys: round(jitter(120, 0.05)),
        bp_dia: round(jitter(78, 0.05)),
        confidence: round(0.8 + Math.random() * 0.15, 2),
        reasons: [],
      };
  }
}

/**
 * Scripted scenario state (scenario minutes, scaled by speed).
 * - 0–2 min: victims arrive GREEN/YELLOW
 * - ~3 min: one victim YELLOW→RED (node index 0 if assigned)
 * - battery decay; one node <20
 * - one node pause then resume
 */
function scenarioAt(scenarioMin, nodeState, opts) {
  const { degradeNodeIndex, lowBatteryIndex, offlineNodeIndex } = opts;

  // Arrival window 0–2 min: assign RFID if not yet
  if (nodeState.rfid == null && scenarioMin >= nodeState.arriveAt) {
    nodeState.rfid = String(3000 + opts.rfidOffset + nodeState.index);
    // mostly GREEN/YELLOW; first node starts YELLOW so it can degrade
    if (nodeState.index === degradeNodeIndex) {
      nodeState.priority = "YELLOW";
    } else if (nodeState.index % 4 === 3) {
      nodeState.priority = "YELLOW";
    } else {
      nodeState.priority = "GREEN";
    }
  }

  // ~3 min: deterministic YELLOW→RED on degrade node
  if (
    nodeState.index === degradeNodeIndex &&
    nodeState.rfid != null &&
    scenarioMin >= 3 &&
    !nodeState.degraded
  ) {
    nodeState.priority = "RED";
    nodeState.degraded = true;
  }

  // Battery decay from 95; low-battery node drops faster to <20 around min 2.5
  const baseStart = 95 - nodeState.index * 2;
  let battery = baseStart - scenarioMin * 3;
  if (nodeState.index === lowBatteryIndex) {
    battery = 45 - scenarioMin * 12; // crosses <20 by ~2.1 scenario min
  }
  nodeState.battery = Math.max(5, Math.min(100, round(battery)));

  // Offline window: scenario min 4–5.5 for offlineNode
  if (nodeState.index === offlineNodeIndex) {
    if (scenarioMin >= 4 && scenarioMin < 5.5) {
      nodeState.paused = true;
    } else {
      if (nodeState.paused) nodeState.resumed = true;
      nodeState.paused = false;
    }
  }
}

function buildVital(nodeState) {
  if (nodeState.rfid == null) {
    // no victim yet - still may publish battery-only style with null rfid
    return {
      victim_rfid: null,
      hr: 0,
      spo2: 0,
      rr: 0,
      bp_sys: null,
      bp_dia: null,
      battery: nodeState.battery,
      priority: "GREEN",
      confidence: 0.5,
      reasons: [],
      ts: new Date().toISOString(),
    };
  }
  const v = vitalsFor(nodeState.priority);
  return {
    victim_rfid: nodeState.rfid,
    hr: v.hr,
    spo2: v.spo2,
    rr: v.rr,
    bp_sys: v.bp_sys,
    bp_dia: v.bp_dia,
    battery: nodeState.battery,
    priority: nodeState.priority,
    confidence: v.confidence,
    reasons: v.reasons,
    ts: new Date().toISOString(),
  };
}

function pub(client, topic, payload, opts = {}) {
  return new Promise((resolve, reject) => {
    client.publish(
      topic,
      JSON.stringify(payload),
      { qos: opts.qos ?? 1, retain: !!opts.retain },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv);
  const { stations, nodes } = buildTopology(args.stations, args.nodes);

  console.log("=== TriageBox earthquake simulator ===");
  console.log(
    `broker=${args.broker} stations=${args.stations} nodes/station=${args.nodes} duration=${args.duration}s speed=${args.speed}x`,
  );
  console.log(`stations: ${stations.join(", ")}`);
  console.log(
    `nodes: ${nodes.map((n) => `${n.stationId}/${n.nodeId}`).join(", ")}`,
  );
  console.log("");
  console.log("IMPORTANT: nodes must be PRE-REGISTERED.");
  console.log(
    "  Seed (T15) creates st-01,st-02 + node-01..node-10 (5 per station).",
  );
  console.log("  Or: curl POST /api/stations + /api/nodes for each id above.");
  console.log("  Unknown station/node ids are dropped by the backend.");
  console.log("");

  const degradeNodeIndex = 0; // node-01: YELLOW→RED @ scenario min 3
  const lowBatteryIndex = Math.min(1, nodes.length - 1); // node-02
  const offlineNodeIndex = Math.min(2, nodes.length - 1); // node-03 pause

  const nodeStates = nodes.map((n, i) => ({
    ...n,
    index: i,
    rfid: null,
    priority: "GREEN",
    battery: 95 - i * 2,
    arriveAt: (i / Math.max(nodes.length - 1, 1)) * 2, // spread 0–2 scenario min
    degraded: false,
    paused: false,
    resumed: false,
    packetCount: 0,
  }));

  const scenarioOpts = {
    degradeNodeIndex,
    lowBatteryIndex,
    offlineNodeIndex,
    rfidOffset: args.rfidOffset,
  };

  const client = mqttLib.connect(args.broker, {
    clientId: `triagebox-sim-${Date.now()}`,
    reconnectPeriod: 1000,
  });

  await new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("MQTT connect timeout")),
      10000,
    );
    client.once("connect", () => {
      clearTimeout(t);
      console.log("mqtt connected");
      resolve();
    });
    client.once("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });

  // Station LWT offline retained (optional nicety); clear with ONLINE heartbeats
  for (const sid of stations) {
    client.publish(
      `triagebox/${sid}/status`,
      JSON.stringify({ status: "OFFLINE" }),
      { qos: 1, retain: true },
    );
  }

  const startWall = Date.now();
  const endWall = startWall + args.duration * 1000;
  const vitalIntervalMs = Math.max(50, 15_000 / args.speed); // 15s scenario / speed
  const statusIntervalMs = Math.max(100, 30_000 / args.speed);
  const heartbeatIntervalMs = Math.max(100, 20_000 / args.speed);

  let lastVital = 0;
  let lastStatus = 0;
  let lastHb = 0;
  let vitalTicks = 0;
  let statusTicks = 0;
  let hbTicks = 0;
  let offlineEvents = 0;
  let resumeEvents = 0;
  let degradeEvents = 0;

  // Initial ONLINE for stations + nodes
  for (const sid of stations) {
    await pub(
      client,
      `triagebox/${sid}/status`,
      { status: "ONLINE" },
      { retain: true },
    );
    hbTicks++;
  }
  for (const ns of nodeStates) {
    await pub(client, `triagebox/${ns.stationId}/${ns.nodeId}/status`, {
      status: "ONLINE",
      rssi: -50 - ns.index,
      snr: 8 + (ns.index % 3),
      battery: ns.battery,
      firmware: "sim-1.0.0",
      packet_count: 0,
    });
    statusTicks++;
  }

  console.log(
    `loop: vital every ${vitalIntervalMs}ms, status ${statusIntervalMs}ms, station hb ${heartbeatIntervalMs}ms`,
  );
  console.log(
    `scripted: degrade=${nodes[degradeNodeIndex]?.nodeId} lowBatt=${nodes[lowBatteryIndex]?.nodeId} offline=${nodes[offlineNodeIndex]?.nodeId}`,
  );

  while (Date.now() < endWall) {
    const now = Date.now();
    const scenarioMin = (((now - startWall) / 1000) * args.speed) / 60;

    for (const ns of nodeStates) {
      const wasPaused = ns.paused;
      const wasDegraded = ns.degraded;
      scenarioAt(scenarioMin, ns, scenarioOpts);
      if (ns.degraded && !wasDegraded) {
        degradeEvents++;
        console.log(
          `[t=${scenarioMin.toFixed(2)}m] DEGRADE ${ns.nodeId} YELLOW→RED rfid=${ns.rfid}`,
        );
      }
      if (ns.paused && !wasPaused) {
        offlineEvents++;
        console.log(
          `[t=${scenarioMin.toFixed(2)}m] PAUSE ${ns.nodeId} (offline)`,
        );
        await pub(client, `triagebox/${ns.stationId}/${ns.nodeId}/status`, {
          status: "OFFLINE",
          battery: ns.battery,
          packet_count: ns.packetCount,
        });
        statusTicks++;
      }
      if (!ns.paused && wasPaused) {
        resumeEvents++;
        console.log(`[t=${scenarioMin.toFixed(2)}m] RESUME ${ns.nodeId}`);
        await pub(client, `triagebox/${ns.stationId}/${ns.nodeId}/status`, {
          status: "ONLINE",
          rssi: -55,
          snr: 8,
          battery: ns.battery,
          firmware: "sim-1.0.0",
          packet_count: ns.packetCount,
        });
        statusTicks++;
      }
    }

    if (now - lastVital >= vitalIntervalMs) {
      lastVital = now;
      for (const ns of nodeStates) {
        if (ns.paused) continue;
        const payload = buildVital(ns);
        ns.packetCount++;
        await pub(
          client,
          `triagebox/${ns.stationId}/${ns.nodeId}/vital`,
          payload,
          { qos: 1 },
        );
        vitalTicks++;
      }
    }

    if (now - lastStatus >= statusIntervalMs) {
      lastStatus = now;
      for (const ns of nodeStates) {
        if (ns.paused) continue;
        await pub(client, `triagebox/${ns.stationId}/${ns.nodeId}/status`, {
          status: "ONLINE",
          rssi: -50 - (ns.index % 20),
          snr: 7 + Math.random() * 3,
          battery: ns.battery,
          firmware: "sim-1.0.0",
          packet_count: ns.packetCount,
        });
        statusTicks++;
      }
    }

    if (now - lastHb >= heartbeatIntervalMs) {
      lastHb = now;
      for (const sid of stations) {
        await pub(
          client,
          `triagebox/${sid}/status`,
          { status: "ONLINE" },
          { retain: true },
        );
        hbTicks++;
      }
    }

    await sleep(50);
  }

  // Final ONLINE heartbeat
  for (const sid of stations) {
    await pub(
      client,
      `triagebox/${sid}/status`,
      { status: "ONLINE" },
      { retain: true },
    );
  }

  console.log("");
  console.log("=== simulator done ===");
  console.log(`vitals published: ${vitalTicks}`);
  console.log(`node status pubs: ${statusTicks}`);
  console.log(`station heartbeats: ${hbTicks}`);
  console.log(
    `degrade events: ${degradeEvents} offline: ${offlineEvents} resume: ${resumeEvents}`,
  );
  console.log(
    `low-battery target: ${nodes[lowBatteryIndex]?.nodeId} final batt=${nodeStates[lowBatteryIndex]?.battery}`,
  );
  for (const ns of nodeStates) {
    console.log(
      `  ${ns.nodeId} rfid=${ns.rfid} priority=${ns.priority} battery=${ns.battery} packets=${ns.packetCount}`,
    );
  }

  await new Promise((resolve) => client.end(false, {}, resolve));
  process.exit(0);
}

main().catch((err) => {
  console.error("simulator failed:", err.message || err);
  process.exit(1);
});
