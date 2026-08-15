# TriageBox API Contract

This document freezes the minimal MQTT, REST, and WebSocket contract. JSON field names are `snake_case` on MQTT and `camelCase` on REST/WebSocket.

## Priority enum

`RED | YELLOW | GREEN | BLACK`

No other value is valid.

## MQTT topics and payloads

### Vital

- Topic: `triagebox/{station_id}/{node_id}/vital`
- QoS: **1**

Canonical JSON (legacy station / tests):

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
| `victim_rfid`        | `victim_rfid`       | string or number → string                                       |
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

SVM note: `reasons` may be an empty array when the model has no reason codes.

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

## Identity rules

- Stations and nodes are pre-registered. MQTT never creates them.
- A message from an unknown `station_id` or `node_id` is dropped and logged.
- A new non-null RFID auto-creates a victim; the same RFID identifies the same victim.
- A node may be rebound to another victim by publishing another `victim_rfid`.
- A null `victim_rfid` does not create a victim.

## REST paths

All paths return JSON. List resources use arrays unless a wrapper is shown.

| Method/path                          | Minimal request/response shape                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `GET /api/kpis`                      | `{ total, byPriority: { RED, YELLOW, GREEN, BLACK }, onlineNodes, totalNodes, onlineStations, totalStations }` |
| `GET /api/victims`                   | `Victim[]`                                                                                                     |
| `GET /api/victims/:id`               | `Victim`                                                                                                       |
| `GET /api/nodes`                     | `Node[]`                                                                                                       |
| `POST /api/nodes`                    | node registration fields → `Node`                                                                              |
| `GET/PATCH/DELETE /api/nodes/:id`    | `Node`                                                                                                         |
| `GET /api/stations`                  | `Station[]`                                                                                                    |
| `POST /api/stations`                 | station registration fields → `Station`                                                                        |
| `GET/PATCH/DELETE /api/stations/:id` | `Station`                                                                                                      |
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
  gender?: "M" | "F" | "U" | null;
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
| `victim.priority_changed` | `{ victimId, rfid, from, to, confidence, reasons, nodeId }`                 |
| `vital.updated`           | `{ victimId, nodeId, hr, spo2, rr, bpSys?, bpDia?, battery, priority, ts }` |
| `node.status`             | `{ nodeId, status, battery?, rssi?, snr?, lastSeen }`                       |
| `station.status`          | `{ stationId, status, lastSeen }`                                           |
| `alert.created`           | `Alert`                                                                     |
| `activity.created`        | `Activity`                                                                  |
| `kpi.updated`             | `{ total, byPriority: { RED, YELLOW, GREEN, BLACK } }`                      |
