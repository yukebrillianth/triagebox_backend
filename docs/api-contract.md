# TriageBox API Contract

This document freezes the minimal MQTT, REST, and WebSocket contract. JSON field names are `snake_case` on MQTT and `camelCase` on REST/WebSocket.

## Priority enum

`RED | YELLOW | GREEN | BLACK`

No other value is valid.

## MQTT topics and payloads

### Vital

- Topic: `triagebox/{station_id}/{node_id}/vital`
- QoS: **1**

Canonical JSON (legacy station / tests — `esi`/`age`/`gender` arrive with node
firmware v0x02 and are omitted by every station until then):

```json
{
  "victim_rfid": "3021",
  "hr": 90,
  "spo2": 98,
  "rr": 18,
  "bp_sys": 120,
  "bp_dia": 80,
  "battery": 80,
  "priority": "GREEN",
  "confidence": 0.9,
  "esi": 4,
  "age": 62,
  "gender": "M",
  "reasons": [],
  "ts": "2026-07-25T00:00:00.000Z"
}
```

Binary-decoder aliases (station JSON after LoRa decode). Backend normalizes to the canonical shape above.

| Binary / alias field | Canonical field     | Notes                                                           |
| -------------------- | ------------------- | --------------------------------------------------------------- |
| `timestamp`          | `ts`                | epoch seconds (uint32) or ms; ISO string still accepted on `ts` |
| `triage_level`       | `priority`          | `0=BLACK`, `1=RED`, `2=YELLOW`, `3=GREEN`                       |
| `heart_rate`         | `hr`                |                                                                 |
| `respiratory_rate`   | `rr`                |                                                                 |
| `confidence`         | `confidence`        | `0–1` float **or** `0–100` percent → stored as `0–1`            |
| `esi`                | (stored on reading) | int `1–5`; `0` or absent → `null` (see below)                    |
| `age`                | (stored on victim)  | int **years**, `1–120`; `0` or absent → `null`                   |
| `gender`             | (stored on victim)  | `"M"` or `"F"` only; case-folded; absent → `null`                |
| `victim_rfid`        | `victim_rfid`       | string or number → `TB-` + upper case (see below)                |
| `ecg_status`         | (stored on reading) | optional string/number → string                                 |
| `device_status`      | (stored on reading) | optional string/number → string                                 |
| `packet_counter`     | (optional meta)     | not required for ingest                                         |
| `packet_version`     | (optional meta)     | **CRC / packet_version validated on station only**              |

Example (binary-style):

```json
{
  "victim_rfid": 3021,
  "heart_rate": 90,
  "spo2": 98,
  "respiratory_rate": 18,
  "battery": 80,
  "triage_level": 3,
  "confidence": 91,
  "reasons": [],
  "timestamp": 1720000000,
  "ecg_status": 0,
  "device_status": 0
}
```

`victim_rfid` may be `null`. `bp_sys`, `bp_dia`, and `ts`/`timestamp` may be omitted; blood-pressure fields may also be `null`.

**Patient ids are normalized on ingest to `TB-` plus the card UID in upper case.**
The station sends the bare UID (`04a2b3`, or a number from the simulator) and
`Victim.rfid` stores `TB-04A2B3`, which is the form every REST response, WebSocket
event and report carries. Normalization is idempotent, so a payload that already
has the prefix is not double-prefixed. `T` never occurs in hex, so a real UID
cannot be mistaken for an already-prefixed id.

The prefix is not on the LoRa wire, deliberately: it is a constant, so sending it
would spend three bytes of airtime per reading to transmit something that never
changes, and the node's RFID field is sized with no spare bytes. The node's own LCD
prints the identical prefix locally so the operator and the dashboard name the same
patient the same way.

Because `Victim.rfid` is `@unique`, a database that already holds bare ids will
treat the same card as a new patient after this change. For an existing dataset:
`UPDATE "Victim" SET rfid = 'TB-' || upper(rfid) WHERE rfid NOT LIKE 'TB-%';`

SVM note: `reasons` may be an empty array when the model has no reason codes.

#### Required vs optional

**`priority` (or `triage_level`) is the only mandatory measurement.** It drives triage, the KPIs and the alerts, so a reading without one has nothing to say. Everything else may be **omitted entirely**:

| Field                                     | Required | Absent means |
| ----------------------------------------- | -------- | ------------ |
| `priority` / `triage_level`                | **yes**  | payload rejected |
| `hr` / `heart_rate`                        | no       | `null`       |
| `spo2`                                     | no       | `null`       |
| `rr` / `respiratory_rate`                  | no       | `null`       |
| `battery`                                  | no       | `null`       |
| `confidence`                               | no       | `null`       |
| `esi`                                      | no       | `null` (model did not score) |
| `age`                                      | no       | `null` (Age screen never answered) |
| `gender`                                   | no       | `null` (never asked) |
| `victim_rfid`                              | no       | `null` (no victim created) |
| `bp_sys`, `bp_dia`, `ts`, `reasons`, `ecg_status`, `device_status`, `packet_counter`, `packet_version` | no | `null` / `[]` |

**Absent is stored as `null`, never as `0`.** Producers must omit a key rather than substitute a zero: `hr` 0 is a dead patient, `spo2` 0 is asphyxia, `battery` 0 is a flat node, and `priority` 0 is BLACK. A fabricated zero is indistinguishable from a measured one. `VitalReading.hr`, `spo2`, `rr`, `battery`, `esi`, `age` and `confidence` are nullable columns for the same reason — `age` 0 would read as a newborn and `esi` 0 is not a class that exists, so both also land as `null` if a producer ever sends the literal `0`.

#### `esi`, `age`, `gender`

- **`esi`** is the on-device model's raw Emergency Severity Index, int `1–5`. The device's displayed colour collapses ESI 3, 4 and 5 all into GREEN, so this field is the only place a walking-wounded ESI 5 stays distinguishable from a could-deteriorate ESI 3 downstream. It is **per-reading** (`VitalReading.esi`, and carried on `TriageHistory.esi` / `victim.priority_changed` at the moment of a transition) — never a victim attribute. Absent or `0` means the model refused to score. Out-of-range values are rejected, not clamped.
- **`age`** is **years** — the number the model actually scored. The operator picks a band on the device and the firmware sends the band's clinical mid-point, so it is not a band index. Valid range `1–120`. It is stored on the **victim** (`Victim.age`) and is *write-once-ish*: a later reading that omits it never blanks a previously known value; correct it over `PATCH /api/victims/:id`.
- **`gender`** is `"M"` or `"F"` (case-folded on ingest). There is no `'U'` from the wire — the station omits the key when the question was never asked, and a fabricated `'U'` would read downstream as a real answer. Stored on the victim (`Victim.gender`), same never-blank rule as `age`. (An operator may still set `'U'` over the victims PATCH endpoint — that is a person saying "unknown", not a device inventing one.)

No alert, KPI, or triage decision is derived from `esi`; it is provenance for the verdict that already exists.

Numbers must be JSON numbers. There is no string coercion — `"hr": "90"` is rejected. Only `victim_rfid` accepts either a string or a number.

`scripts/check-station-payload.ts` (`npm run check:station`) freezes this contract against the ESP32 station's real output; run it after touching `vitalSchema`.

`packet_count` on node status also accepts alias `packet_counter`.

### Node status

- Topic: `triagebox/{station_id}/{node_id}/status`

```json
{
  "status": "ONLINE",
  "rssi": -67,
  "snr": 8.5,
  "battery": 74,
  "firmware": "1.2.0",
  "packet_count": 152
}
```

`status` is `ONLINE | OFFLINE`. All other fields are optional.

### Station status / heartbeat / LWT

- Topic: `triagebox/{station_id}/status`

```json
{ "status": "ONLINE" }
```

`status` is `ONLINE | OFFLINE`; the retained LWT payload is `{"status":"OFFLINE"}`.

There is no MQTT alert topic. The backend derives alerts from accepted MQTT data.

## Station / node ID mapping (binary LoRa)

Station firmware is responsible for mapping binary `node_id` (uint8) to the **registered string** node id used on MQTT topics and in the database.

| Binary (uint8) | Registered string id (example) |
| -------------- | ------------------------------ |
| `7`            | `node-07`                      |
| `12`           | `node-12`                      |

Rules:

- Backend never invents node ids from binary fields; topics must already carry the registered string (`triagebox/{station_id}/{node_id}/vital`).
- `packet_version` and CRC validation are **station-only** - backend accepts post-decode JSON and does not re-check CRC.
- Unknown `station_id` / `node_id` on MQTT is dropped (pre-registration required).

### Announce (adoption)

- Topic: `triagebox/{station_id}/announce`
- QoS: **1**, **retained**
- Published on every successful MQTT connect, right after the ONLINE status.

```json
{
  "station_id": "st-03",
  "mac": "AA:BB:CC:DD:EE:FF",
  "ip": "192.168.50.13",
  "firmware": "1.0.0",
  "node_count": 20
}
```

`station_id` and `mac` are required; `ip`, `firmware` and `node_count` are optional.

**The only topic that does not require pre-registration** — an unknown station is the point. It does not create a `Station`: the announce is recorded as a `PendingStation` keyed on `mac`, and an operator turns it into a real station via `POST /api/stations/adopt`. So `MQTT never creates a device` still holds; adoption is the visible door.

`mac` is the identity because it is the only field a station cannot change from its own configuration. Everything else in the payload is a suggestion the operator may override when adopting.

An announce whose `station_id` is already registered is ignored, not an error — the retained message is republished on every reconnect.

Retained so a dashboard opened after the station booted still sees the candidate.

## Identity rules

- Stations and nodes are pre-registered, or adopted from an announce. MQTT never creates them directly.
- A message from an unknown `station_id` or `node_id` is dropped and logged — except on `announce`.
- A new non-null RFID auto-creates a victim; the same RFID identifies the same victim.
- A node may be rebound to another victim by publishing another `victim_rfid`.
- A null or absent `victim_rfid` does not create a victim.

## REST paths

All paths return JSON. List resources use arrays unless a wrapper is shown.

| Method/path                          | Minimal request/response shape                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `GET /api/kpis`                      | `{ total, byPriority: { RED, YELLOW, GREEN, BLACK }, onlineNodes, totalNodes, onlineStations, totalStations }` |
| `GET /api/victims`                   | `Victim[]`                                                                                                     |
| `GET /api/victims/:id`               | `Victim`                                                                                                       |
| `GET /api/victims/:id/vitals`        | `VitalReading[]` — per-reading history, newest first                                                           |
| `GET /api/victims/:id/triage-history`| `TriageHistory[]` — priority transitions, newest first                                                         |
| `PATCH /api/victims/:id`             | `{ name?, age?, gender?, notes? }` → `Victim` — operator corrections; `gender` accepts `"U"` here              |
| `GET /api/nodes`                     | `Node[]`                                                                                                       |
| `POST /api/nodes`                    | node registration fields → `Node`                                                                              |
| `GET/PATCH/DELETE /api/nodes/:id`    | `Node`                                                                                                         |
| `GET /api/stations`                  | `Station[]`                                                                                                    |
| `POST /api/stations`                 | station registration fields → `Station`                                                                        |
| `GET/PATCH/DELETE /api/stations/:id` | `Station`                                                                                                      |
| `GET /api/stations/pending`          | `PendingStation[]` — `{ mac, announcedStationId, ip, firmware, nodeCount, firstSeen, lastSeen }`               |
| `POST /api/stations/adopt`           | `{ mac, id, name, nodeCount?, nodeIdBase? }` → `Station` (creates `node-NN` for `nodeCount` nodes)             |
| `DELETE /api/stations/pending/:mac`  | `PendingStation` — removes the candidate without adopting                                                      |
| `GET /api/alerts`                    | `Alert[]`                                                                                                      |
| `GET /api/activity`                  | `Activity[]`                                                                                                   |
| `GET /api/analytics/summary`         | `{ byPriority, hourlyTrend, activeNodes, avgBatteryByNode, latestSignalByNode }`                               |
| `GET /api/settings`                  | `{ [key: string]: string }`                                                                                    |
| `PUT /api/settings`                  | key/value object → updated key/value object                                                                    |
| `GET /api/health`                    | `{ status, db, mqtt, uptimeSec }`                                                                              |
| `GET /api/reports/summary`           | `{ victims, counts, triageHistoryCount, activityTimeline }`                                                    |

Minimal shared resource shapes:

```ts
type Victim = {
  id: string;
  rfid: string;
  name?: string | null;
  age?: number | null; // years; null until the device or an operator supplies one
  gender?: "M" | "F" | "U" | null; // MQTT only sends M/F; "U" only via PATCH
  currentPriority: "RED" | "YELLOW" | "GREEN" | "BLACK";
  currentNodeId?: string | null;
  hr?: number | null;
  spo2?: number | null;
  rr?: number | null;
  bpSys?: number | null;
  bpDia?: number | null;
  battery?: number | null;
  confidence?: number | null;
  reasons?: string[];
  lastSeen?: string | null;
};

// GET /api/victims/:id/vitals — VitalReading rows, newest first
type VitalReading = {
  id: string;
  victimId: string;
  nodeId: string;
  hr: number | null;
  spo2: number | null;
  rr: number | null;
  bpSys: number | null;
  bpDia: number | null;
  battery: number | null;
  priority: "RED" | "YELLOW" | "GREEN" | "BLACK";
  confidence: number | null;
  esi: number | null; // 1-5 raw score behind `priority`; null = model did not score
  reasons: string[];
  ecgStatus: string | null;
  deviceStatus: string | null;
  deviceTs: string | null;
  receivedAt: string;
};

// GET /api/victims/:id/triage-history — newest first
type TriageHistory = {
  id: string;
  victimId: string;
  fromPriority: "RED" | "YELLOW" | "GREEN" | "BLACK";
  toPriority: "RED" | "YELLOW" | "GREEN" | "BLACK";
  confidence: number | null;
  reasons: string[] | null;
  esi: number | null; // ESI in force at the transition, when known
  nodeId: string | null;
  createdAt: string;
};

type Node = {
  id: string;
  stationId: string;
  name: string;
  status: "ONLINE" | "OFFLINE";
  battery?: number | null;
  rssi?: number | null;
  snr?: number | null;
  lastSeen?: string | null;
};
type Station = {
  id: string;
  name: string;
  status: "ONLINE" | "OFFLINE";
  lastSeen?: string | null;
};
type Alert = {
  id: string;
  type: string;
  severity: string;
  message: string;
  createdAt: string;
};
type Activity = {
  id: string;
  type: string;
  message: string;
  createdAt: string;
};
```

## WebSocket events

Socket.IO broadcasts are fire-and-forget after database commit. There are no rooms, replay, or backlog; clients bootstrap through REST before consuming events.

| Event                     | Payload                                                                     |
| ------------------------- | --------------------------------------------------------------------------- |
| `victim.created`          | `Victim` snapshot                                                           |
| `victim.updated`          | `Victim` snapshot                                                           |
| `victim.priority_changed` | `{ victimId, rfid, from, to, confidence, reasons, esi, nodeId }`            |
| `vital.updated`           | `{ victimId, nodeId, hr, spo2, rr, bpSys?, bpDia?, battery, priority, esi, ts }` — every measurement and `esi` may be `null`; `esi` null means the model did not score |
| `node.status`             | `{ nodeId, status, battery?, rssi?, snr?, lastSeen }`                       |
| `station.status`          | `{ stationId, status, lastSeen }`                                           |
| `station.pending`         | `PendingStation` — a station is awaiting adoption                           |
| `alert.created`           | `Alert`                                                                     |
| `activity.created`        | `Activity`                                                                  |
| `kpi.updated`             | `{ total, byPriority: { RED, YELLOW, GREEN, BLACK } }`                      |
