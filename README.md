# TriageBox Backend

Backend NestJS untuk PKM-KC 2026 **TriageBox**: ingest MQTT dari station/node lapangan → PostgreSQL → REST + WebSocket untuk dashboard command-center.

## 1. Prasyarat

- **Docker** + Docker Compose (Postgres + Mosquitto)
- **Node.js 20+**
- Port bebas: `3001` (API/WS), `5432` (Postgres), `1883` (MQTT)

## 2. Jalankan infrastruktur

Dari root repo `triagebox-backend/`:

```bash
docker compose up -d
docker compose ps   # postgres + mosquitto healthy
```

## 3. Install, migrasi, seed

```bash
cp .env.example .env
npm i
npx prisma migrate deploy
npm run seed
```

Seed idempotent (aman dijalankan berulang):

| Entity  | ID                                           | Catatan                                              |
| ------- | -------------------------------------------- | ---------------------------------------------------- |
| Station | `st-01`, `st-02`                             | sample IP + MQTT broker                              |
| Node    | `node-01` … `node-05`                        | → `st-01`                                            |
| Node    | `node-06` … `node-10`                        | → `st-02`                                            |
| Setting | `hospital_name`, `disaster_name`, `operator` | default demo (tidak menimpa nilai yang sudah diubah) |

## 4. Jalankan backend

```bash
npm run start:dev
# production: npm run build && npm run start:prod
```

API default: `http://localhost:3001`

## 5. Simulator (demo tanpa hardware)

Setelah seed + backend jalan (simulator terpisah di T14):

```bash
node simulator/index.js --stations 2 --nodes 5 --duration 90 --speed 10
```

Gunakan id yang sama dengan seed (`st-01`/`st-02`, `node-01`…`node-10`).

## 6. Contoh curl

```bash
# Health
curl -s localhost:3001/api/health | jq .

# KPI
curl -s localhost:3001/api/kpis | jq .

# Victims & alerts
curl -s localhost:3001/api/victims | jq .
curl -s localhost:3001/api/alerts | jq .

# Inventory (seed)
curl -s localhost:3001/api/stations | jq 'length'   # 2
curl -s 'localhost:3001/api/nodes?includeInactive=true' | jq 'length'  # 10
```

Kontrak lengkap REST/MQTT/WS: [`docs/api-contract.md`](docs/api-contract.md).

## 7. Arsitektur singkat + MQTT

```
Node1..N (LoRa + ML)                 Node1..N
      │                                    │
[Station ESP32 #1] ──MQTT──┐    ┌──MQTT── [Station #2]
                           ▼    ▼
                      [Mosquitto :1883]
                           │
                    [NestJS Backend :3001]
                      │         │
               [PostgreSQL]  [Socket.IO WS]
```

| Topic                                     | Isi                                            |
| ----------------------------------------- | ---------------------------------------------- |
| `triagebox/{station_id}/{node_id}/vital`  | vital + priority + RFID (QoS 1)                |
| `triagebox/{station_id}/{node_id}/status` | status node (ONLINE/OFFLINE, rssi, battery, …) |
| `triagebox/{station_id}/status`           | heartbeat / LWT station                        |

Tidak ada topic MQTT alert - alert diturunkan di backend.

## 8. Aturan identitas

- **Station & Node pre-register** (REST CRUD atau `npm run seed`). MQTT **tidak** membuat perangkat. `station_id` / `node_id` unknown → drop + log.
- **Victim auto** dari `victim_rfid` non-null (upsert by RFID). RFID kosong → update status node saja, tanpa victim baru.
- Node boleh ganti pasien (RFID baru → rebind). RFID sama di 2 node → 1 victim, `current_node_id` = last writer.

## 9. Peta port

| Port     | Layanan                 |
| -------- | ----------------------- |
| **3001** | NestJS REST + Socket.IO |
| **5432** | PostgreSQL              |
| **1883** | Mosquitto MQTT          |

## Variabel lingkungan

Lihat [`.env.example`](.env.example):

- `DATABASE_URL` - Postgres
- `MQTT_URL` - default `mqtt://localhost:1883`
- `PORT` - default `3001`
- `NODE_OFFLINE_SEC` - threshold offline node (default 45)
- `BATTERY_LOW_PCT` - alert baterai rendah (default 20)
- `CORS_ORIGIN` - default `*`

## Skrip npm

| Script                    | Fungsi                     |
| ------------------------- | -------------------------- |
| `npm run start:dev`       | backend watch mode         |
| `npm run build`           | compile NestJS → `dist/`   |
| `npm run start:prod`      | `node dist/main.js`        |
| `npm run seed`            | seed station/node/settings |
| `npm run prisma:migrate`  | migrate dev                |
| `npm run prisma:generate` | generate Prisma client     |
