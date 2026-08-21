# Panduan Firmware Station (ESP32 + W5500) → MQTT

Dokumen ini untuk developer yang menulis firmware **station** TriageBox: ESP32
dual-core dengan Ethernet W5500, yang menerima paket biner dari node lewat LoRa
lalu meneruskannya ke broker MQTT sebagai JSON.

Backend adalah **konsumen pasif**. Ia tidak pernah membuat station atau node,
tidak pernah meminta ulang data yang hilang, dan tidak pernah memvalidasi CRC.
Semua tanggung jawab itu ada di station. Kontrak lengkapnya di
[`api-contract.md`](api-contract.md); dokumen ini adalah sisi firmware-nya.

---

## 1. Yang harus disiapkan sebelum firmware jalan

Station dan node **wajib terdaftar lebih dulu** di database. Pesan MQTT dari
`station_id` atau `node_id` yang tidak dikenal akan di-*drop* dan hanya muncul
sebagai `warn` di log backend — tidak ada error yang dikirim balik ke station.

Seed bawaan sudah membuat:

| Station | Node                      |
| ------- | ------------------------- |
| `st-01` | `node-01` … `node-05`     |
| `st-02` | `node-06` … `node-10`     |

Untuk station baru, daftarkan lewat REST sebelum menyalakan perangkat:

```bash
curl -X POST http://localhost:3001/api/stations \
  -H 'Content-Type: application/json' \
  -d '{"id":"st-03","name":"Station Lapangan 3"}'
```

```bash
curl -X POST http://localhost:3001/api/nodes \
  -H 'Content-Type: application/json' \
  -d '{"id":"node-11","stationId":"st-03","name":"Node 11"}'
```

`id` maksimal 64 karakter. Gunakan format yang stabil dan bisa dipetakan dari
`node_id` biner LoRa (lihat §5).

---

## 2. Tiga topik, satu arah

Station hanya **publish**. Tidak ada satu pun topik yang perlu di-subscribe, dan
tidak ada topik alert — alert diturunkan backend dari data yang masuk.

| Topik                                     | QoS | Retain | Cadence           |
| ----------------------------------------- | --- | ------ | ----------------- |
| `triagebox/{station_id}/{node_id}/vital`  | 1   | tidak  | tiap vital masuk  |
| `triagebox/{station_id}/{node_id}/status` | 1   | tidak  | ~30 s per node    |
| `triagebox/{station_id}/status`           | 1   | **ya** | ~20 s + LWT       |

Semua payload adalah JSON dengan field `snake_case`. Topik apa pun di luar tiga
pola ini diabaikan backend.

### Koneksi broker

| Parameter | Nilai                                                       |
| --------- | ----------------------------------------------------------- |
| URL       | `mqtt://<host>:1883` — TCP biasa, MQTT 3.1.1                |
| Auth      | tidak ada (`allow_anonymous true` di `mosquitto.conf`)      |
| TLS       | tidak ada                                                   |
| clientId  | unik & stabil, mis. `station-st-01`                         |
| keepalive | 30 s                                                        |

clientId wajib unik per perangkat. Dua perangkat dengan clientId sama akan
saling menendang dari broker dan masuk ke loop reconnect yang terlihat seperti
jaringan tidak stabil.

### LWT: cara station terlihat OFFLINE saat kabel dicabut

Set Last Will pada saat connect:

- topik `triagebox/{station_id}/status`
- payload `{"status":"OFFLINE"}`
- QoS 1, **retain 1**

Broker mengirimkan ini otomatis kalau station mati tanpa `DISCONNECT` yang
rapi. Tepat setelah connect berhasil, publish `{"status":"ONLINE"}` retained
untuk menimpanya.

---

## 3. Payload `vital`

Topik: `triagebox/{station_id}/{node_id}/vital`

Ini satu-satunya payload yang membawa data medis. Bentuk yang dianjurkan untuk
station biner (alias hasil decode LoRa — backend menormalkannya sendiri):

```json
{
  "victim_rfid": "3021",
  "heart_rate": 132,
  "spo2": 88,
  "respiratory_rate": 34,
  "bp_sys": 90,
  "bp_dia": 60,
  "battery": 74,
  "triage_level": 1,
  "confidence": 93,
  "reasons": ["hr_high", "spo2_low"],
  "timestamp": 1755500000,
  "ecg_status": 0,
  "device_status": 0,
  "packet_counter": 1523,
  "packet_version": 2
}
```

### Field per field

| Field                                | Wajib | Tipe                | Catatan                                                     |
| ------------------------------------ | ----- | ------------------- | ----------------------------------------------------------- |
| `triage_level` (atau `priority`)     | **ya** | int 0–3            | `0=BLACK 1=RED 2=YELLOW 3=GREEN`                            |
| `victim_rfid`                        | tidak | string \| angka \| `null` | angka dikonversi ke string. absen/`null` = belum ada korban |
| `heart_rate` (atau `hr`)             | tidak | number              | salah satu nama saja sudah cukup                            |
| `spo2`                               | tidak | number              |                                                             |
| `respiratory_rate` (atau `rr`)       | tidak | number              |                                                             |
| `battery`                            | tidak | number              | persen 0–100                                                |
| `confidence`                         | tidak | number              | `0–1` atau `0–100`; >1 dibagi 100, lalu di-*clamp* ke ≤ 1   |
| `reasons`                            | tidak | array string        | default `[]`                                                |
| `bp_sys`, `bp_dia`                   | tidak | number \| `null`    |                                                             |
| `timestamp` (atau `ts`)              | tidak | epoch s / ms / ISO  | lihat peringatan di bawah                                   |
| `ecg_status`, `device_status`        | tidak | string \| number    | disimpan apa adanya di baris pembacaan                      |
| `packet_counter`, `packet_version`   | tidak | int                 | metadata; backend tidak memvalidasinya                      |

**Hilangkan key, jangan tulis nol.** Field yang absen disimpan sebagai `null`,
dan itu yang benar: `hr` 0 berarti pasien meninggal, `spo2` 0 berarti asfiksia,
`battery` 0 berarti node mati. Nol karangan tidak bisa dibedakan dari nol
terukur, jadi jangan pernah mengisi nilai pengganti untuk sensor yang belum
siap — cukup hilangkan key-nya.

`priority` satu-satunya pengecualian: ia menggerakkan triase, KPI, dan alert,
jadi paket tanpa priority tidak punya makna. Kalau ESP32 belum memberi skor,
**jangan publish vital itu sama sekali** — cukup biarkan node status yang
menjaga liveness.

Field asing yang tidak dikenal **diabaikan**, bukan ditolak — jadi menambah
field diagnostik sendiri itu aman.

### Empat kesalahan yang bikin paket di-drop tanpa jejak

Kalau validasi gagal, backend hanya menulis `warn` dan berhenti di situ.
Ini penyebab yang paling sering:

1. **Kirim angka sebagai string.** `"hr": "90"` **gagal**. Zod tidak melakukan
   koersi; hanya `victim_rfid` yang menerima angka maupun string. Serialisasi
   semua field numerik sebagai angka JSON tanpa tanda kutip.
2. **`priority`/`triage_level` hilang.** Satu-satunya field wajib. Kalau belum
   ada skor, tahan paketnya — jangan kirim priority palsu.
3. **`triage_level` di luar 0–3.** Nilai 4 atau 255 (sentinel "unknown" yang
   umum di paket biner) langsung ditolak. Petakan dulu ke 0–3 di station.
4. **`timestamp` dari `millis()`.** Lihat di bawah — ini yang paling sunyi
   akibatnya.

### `timestamp` harus waktu dinding, bukan uptime

Kalau nilainya `< 1e12` backend memperlakukannya sebagai **epoch detik**. Jadi
`millis()` bernilai `45000` diartikan sebagai `1970-01-01T12:30:00Z`.

Akibatnya bukan paket ditolak, tapi lebih halus: `victims.lastUpdate`
dibandingkan dengan `deviceTs`, dan pembacaan yang timestamp-nya lebih tua
**tidak memperbarui snapshot korban** — meskipun baris `VitalReading`-nya tetap
tersimpan. Gejalanya di dashboard: riwayat vital bertambah tapi prioritas korban
membeku.

Tiga pilihan, dari yang paling disarankan:

1. **Hilangkan `timestamp`.** Backend memakai waktu terima server. Untuk
   pemantauan realtime ini benar dan paling sederhana.
2. **SNTP.** `configTime(0, 0, "pool.ntp.org")`, lalu kirim `time(nullptr)`
   setelah jam benar-benar tersinkronisasi. Jangan kirim apa pun sebelum itu.
3. **RTC eksternal** kalau station harus jalan tanpa internet.

Jangan pernah mengirim `millis()`, `esp_timer_get_time()`, atau turunannya.

### Semantik `victim_rfid`

| Nilai                          | Efek di backend                                              |
| ------------------------------ | ------------------------------------------------------------ |
| RFID baru                      | membuat korban baru, mengikat ke node ini                    |
| RFID yang sudah ada            | korban yang sama; node bisa berpindah ikatan ke korban itu   |
| absen, `null`, atau string kosong | **tidak** membuat korban; hanya menyegarkan liveness node  |

Sebelum tag dibaca, hilangkan key-nya atau kirim `null` — jangan kirim
placeholder seperti `"0"` atau `"unknown"`, karena itu akan membuat korban hantu
yang harus dibersihkan manual.

---

## 4. Payload status

### Status node

Topik: `triagebox/{station_id}/{node_id}/status`

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

`status` (`ONLINE` | `OFFLINE`) wajib; sisanya opsional dan hanya ditulis kalau
disertakan. `packet_count` juga menerima nama `packet_counter`.

Ini satu-satunya jalan `rssi`, `snr`, dan `firmware` masuk ke database — payload
`vital` tidak membawanya. Kolom kualitas sinyal di dashboard akan kosong kalau
station tidak pernah mengirim status node.

### Heartbeat station

Topik: `triagebox/{station_id}/status` — publish **retained**.

```json
{ "status": "ONLINE" }
```

Hanya `status` yang dibaca; field lain diabaikan.

---

## 5. Pemetaan `node_id` biner → ID terdaftar

Paket LoRa membawa `node_id` sebagai `uint8`. Topik MQTT **harus** memakai ID
string yang terdaftar. Pemetaan itu tanggung jawab station:

| `uint8` di udara | ID di topik |
| ---------------- | ----------- |
| `7`              | `node-07`   |
| `12`             | `node-12`   |

Backend tidak pernah menebak ID dari isi payload — hanya dari topik. Paket dari
`uint8` yang tidak punya pasangan terdaftar harus **dibuang di station**, bukan
dikirim dengan ID hasil karangan.

Verifikasi CRC dan `packet_version` juga sepenuhnya di station. Backend menerima
JSON pasca-decode apa adanya dan tidak memeriksanya ulang.

---

## 6. Cadence dan ambang waktu

Nilai ini dari `.env` backend; sesuaikan kalau di deployment kalian berbeda.

| Perilaku                        | Sumber              | Default |
| ------------------------------- | ------------------- | ------- |
| Node ditandai OFFLINE           | `NODE_OFFLINE_SEC`  | 45 s    |
| Sapuan pemeriksa offline        | `OfflineService`    | tiap 15 s |
| Alert baterai lemah             | `BATTERY_LOW_PCT`   | < 20 %  |

`lastSeen` node disegarkan oleh **`vital` maupun `status`**. Jadi patokannya
satu: setiap node harus muncul di salah satu dari dua topik itu minimal setiap
**~40 detik** — beri margin di bawah 45 s supaya jitter jaringan tidak memicu
alert offline palsu.

**Jangan bergantung pada `vital` saja untuk liveness.** Vital bisa absen karena
alasan yang sah — node belum diskor, jadi paketnya ditahan sesuai aturan di §3 —
sementara node itu hidup dan menjawab setiap poll. Kalau status node hanya
dipublish saat berubah, backend akan menandainya OFFLINE setelah 45 detik dan
station tidak punya transisi apa pun untuk memperbaikinya: node hidup tampak mati
selamanya. Karena itu **publish status node secara periodik**, bukan hanya saat
transisi. Bonusnya `rssi`/`snr` di dashboard jadi nilai sekarang, bukan nilai
sejak node itu terakhir berubah status.

Cadence yang dipakai simulator dan aman sebagai titik awal:

| Topik           | Interval |
| --------------- | -------- |
| vital           | 15 s     |
| status node     | 30 s     |
| status station  | 20 s     |

Jangan publish lebih cepat dari yang diperlukan. Setiap `vital` yang diterima
berarti satu baris `VitalReading` baru plus satu broadcast Socket.IO ke semua
dashboard yang terbuka. 10 node pada 15 s sudah 40 baris per menit.

Alert baterai lemah dipicu **saat menyeberangi ambang**, bukan berulang, jadi
`battery` harus persen 0–100. Mengirim milivolt (mis. `3700`) tidak akan pernah
memicunya.

---

## 7. Implementasi di ESP32 + W5500

### Ukuran buffer — periksa ini lebih dulu

Payload `vital` terlengkap dengan RFID EPC 24-karakter adalah **~280 byte**, dan
paket MQTT PUBLISH utuhnya (topik + header) **~320 byte**.

Default buffer PubSubClient adalah **256 byte**. Melebihi itu membuat
`publish()` mengembalikan `false` dan **tidak mengirim apa pun** — tanpa error,
tanpa log. Ini penyebab paling umum "kadang paket hilang" di station berbasis
PubSubClient.

```cpp
mqtt.setBufferSize(512);  // wajib: default 256 memotong payload vital
```

Selalu periksa nilai kembalian `publish()`. Nilai `false` berarti paket tidak
pernah keluar, dan tidak ada yang akan memberitahu kalian selain itu.

### Pembagian core

W5500 berkomunikasi lewat SPI dan LoRa biasanya juga. Bagi pekerjaannya supaya
`loop()` jaringan tidak pernah menunggu radio:

| Core | Tugas                                                           |
| ---- | --------------------------------------------------------------- |
| 0    | radio LoRa: terima paket, cek CRC, petakan `node_id`, taruh di queue |
| 1    | jaringan: `ETH`, MQTT `loop()`, ambil dari queue lalu publish    |

Hubungkan keduanya dengan `xQueueCreate()` berisi struct hasil decode — jangan
memanggil `mqtt.publish()` dari task radio. Objek client MQTT tidak
*thread-safe*; dipakai dari dua task sekaligus akan merusak buffer internal
dengan cara yang sulit dilacak.

Kalau bus SPI dipakai bersama W5500 dan modul LoRa, lindungi dengan mutex — atau
lebih baik, pakai dua host SPI berbeda.

### W5500 lewat `ETH.h`

Butuh **Arduino-ESP32 core 3.x**. Driver W5500 sudah termasuk di core; tidak
perlu library Ethernet tambahan (`Ethernet.h` dari Arduino bisa salah memilih
bus SPI di ESP32).

```cpp
#include <ETH.h>
#include <SPI.h>

SPIClass ethSPI(HSPI);

// Sesuaikan dengan wiring board kalian.
constexpr int ETH_SCK = 18, ETH_MISO = 19, ETH_MOSI = 23, ETH_CS = 5;
constexpr int ETH_IRQ = 4;    // W5500 memakai IRQ; jangan -1
constexpr int ETH_RST = -1;   // -1 kalau tidak dikabel
```

`ETH.begin()` dipanggil **setelah** `ethSPI.begin()` dan **setelah** handler
event terdaftar — kalau dibalik, event `ETH_GOT_IP` bisa terlewat dan station
menunggu selamanya.

### Pilihan library MQTT

| Library                       | QoS 1 publish | Buffer default | Catatan                                   |
| ----------------------------- | ------------- | -------------- | ----------------------------------------- |
| `mqtt_client.h` (esp-mqtt)    | ya            | 1024 B         | sudah ada di core, punya task sendiri     |
| PubSubClient                  | **tidak**     | 256 B          | perlu `setBufferSize()`, `loop()` manual   |

PubSubClient hanya bisa publish pada QoS 0, sementara kontrak meminta QoS 1
untuk `vital`. Karena **esp-mqtt sudah termasuk di dalam Arduino-ESP32 core**
(tidak ada dependensi baru untuk dipasang), ia memenuhi kontrak tanpa biaya
tambahan: QoS 1, LWT, buffer cukup, reconnect otomatis, plus *outbox* yang
mengirim ulang paket QoS 1 setelah koneksi pulih. Sketch di bawah memakainya.

PubSubClient tetap bisa dipakai kalau QoS 0 diterima untuk deployment kalian —
konsekuensinya paket yang hilang di jaringan tidak dikirim ulang, dan pada
cadence 15 s artinya satu titik data hilang sampai siklus berikutnya. Kalau
memilih itu, jangan lupa `setBufferSize(512)`.

### Sketch referensi

Struktur minimal yang benar: satu queue, dua task, publish hanya dari task
jaringan. Bagian LoRa disisakan sebagai stub karena itu domain kalian.

```cpp
#include <ETH.h>
#include <SPI.h>
#include "mqtt_client.h"

static constexpr char STATION_ID[] = "st-01";
static constexpr char MQTT_URI[] = "mqtt://192.168.1.10:1883";

SPIClass ethSPI(HSPI);
constexpr int ETH_SCK = 18, ETH_MISO = 19, ETH_MOSI = 23;
constexpr int ETH_CS = 5, ETH_IRQ = 4, ETH_RST = -1;

/** One decoded LoRa packet, ready to serialize. */
struct Vital {
  char nodeId[16];  // registered string id, e.g. "node-07"
  char rfid[32];    // empty string -> published as null
  uint8_t hr, spo2, rr, battery, triageLevel, confidence;
};

static QueueHandle_t vitalQ;
static esp_mqtt_client_handle_t mqtt = nullptr;
static volatile bool mqttUp = false;
static char stationTopic[64];
```

Serialisasi dan publish — perhatikan `%d` untuk semua angka dan `null` tanpa
tanda kutip saat RFID kosong. Snippet ini mengasumsikan semua sensor terbaca;
kalau ada yang tidak, **hilangkan key-nya** (lihat §3) — bangun bagian opsional
sebagai potongan string terpisah, jangan sebagai argumen kondisional, karena
`"%s%u"` dengan `("", 0)` akan menempelkan `0` ke angka sebelumnya:

```cpp
static void publishVital(const Vital& v) {
  char topic[64];
  snprintf(topic, sizeof(topic), "triagebox/%s/%s/vital", STATION_ID, v.nodeId);

  // Numbers unquoted: the backend rejects "hr": "90" (no string coercion).
  // No timestamp field: the server clock is more trustworthy than ours.
  char body[384];
  int n = snprintf(
    body, sizeof(body),
    "{\"victim_rfid\":%s%s%s,\"heart_rate\":%d,\"spo2\":%d,"
    "\"respiratory_rate\":%d,\"battery\":%d,\"triage_level\":%d,"
    "\"confidence\":%d,\"reasons\":[]}",
    v.rfid[0] ? "\"" : "", v.rfid[0] ? v.rfid : "null", v.rfid[0] ? "\"" : "",
    v.hr, v.spo2, v.rr, v.battery, v.triageLevel, v.confidence);

  if (n < 0 || n >= (int)sizeof(body)) {
    Serial.println("[MQTT] vital truncated, dropped");  // never publish a partial JSON
    return;
  }
  if (esp_mqtt_client_publish(mqtt, topic, body, n, 1, 0) < 0) {
    Serial.printf("[MQTT] publish failed: %s\n", topic);
  }
}

static void publishNodeStatus(const char* nodeId, int rssi, float snr,
                              int battery, uint32_t packets) {
  char topic[64], body[192];
  snprintf(topic, sizeof(topic), "triagebox/%s/%s/status", STATION_ID, nodeId);
  int n = snprintf(body, sizeof(body),
    "{\"status\":\"ONLINE\",\"rssi\":%d,\"snr\":%.1f,\"battery\":%d,"
    "\"firmware\":\"1.0.0\",\"packet_count\":%lu}",
    rssi, snr, battery, (unsigned long)packets);
  esp_mqtt_client_publish(mqtt, topic, body, n, 1, 0);
}
```

Event handler MQTT. `ONLINE` retained dipublish dari sini, bukan dari `setup()`
— pada saat `setup()` selesai koneksi belum tentu terbentuk:

```cpp
static void onMqtt(void*, esp_event_base_t, int32_t id, void* data) {
  switch ((esp_mqtt_event_id_t)id) {
    case MQTT_EVENT_CONNECTED:
      mqttUp = true;
      // Overwrite the retained LWT the broker may still be holding.
      esp_mqtt_client_publish(mqtt, stationTopic, "{\"status\":\"ONLINE\"}", 0, 1, 1);
      Serial.println("[MQTT] connected");
      break;
    case MQTT_EVENT_DISCONNECTED:
      mqttUp = false;
      Serial.println("[MQTT] disconnected");
      break;
    default:
      break;
  }
}
```

Inisialisasi client, termasuk LWT:

```cpp
static void mqttStart() {
  snprintf(stationTopic, sizeof(stationTopic), "triagebox/%s/status", STATION_ID);
  static char clientId[40];
  snprintf(clientId, sizeof(clientId), "station-%s", STATION_ID);

  esp_mqtt_client_config_t cfg = {};
  cfg.broker.address.uri = MQTT_URI;
  cfg.credentials.client_id = clientId;  // must be unique per device
  cfg.session.keepalive = 30;
  cfg.session.last_will.topic = stationTopic;
  cfg.session.last_will.msg = "{\"status\":\"OFFLINE\"}";
  cfg.session.last_will.msg_len = 0;  // 0 = msg is a C string
  cfg.session.last_will.qos = 1;
  cfg.session.last_will.retain = 1;   // retained: dashboard sees it on subscribe

  mqtt = esp_mqtt_client_init(&cfg);
  esp_mqtt_client_register_event(mqtt, MQTT_EVENT_ANY, onMqtt, nullptr);
  esp_mqtt_client_start(mqtt);  // spawns its own task; no loop() call needed
}
```

Dua task dan pembagian core-nya:

```cpp
/** Core 1: the only place that touches the MQTT client. */
static void netTask(void*) {
  Vital v;
  uint32_t lastBeat = 0;
  for (;;) {
    if (xQueueReceive(vitalQ, &v, pdMS_TO_TICKS(500)) == pdTRUE && mqttUp) {
      publishVital(v);
    }
    if (mqttUp && millis() - lastBeat >= 20000) {
      lastBeat = millis();
      esp_mqtt_client_publish(mqtt, stationTopic, "{\"status\":\"ONLINE\"}", 0, 1, 1);
    }
  }
}

/** Core 0: radio only. Never publishes — the client is not thread-safe. */
static void loraTask(void*) {
  for (;;) {
    Vital v = {};
    if (!loraReceive(&v)) {          // your decoder: CRC + packet_version + id map
      vTaskDelay(pdMS_TO_TICKS(10));
      continue;
    }
    // Full queue means the link is down; drop the oldest, keep the newest.
    if (xQueueSend(vitalQ, &v, 0) != pdTRUE) {
      Vital discard;
      xQueueReceive(vitalQ, &discard, 0);
      xQueueSend(vitalQ, &v, 0);
    }
  }
}
```

`setup()` — urutan di sini penting:

```cpp
static void onEth(arduino_event_id_t event, arduino_event_info_t) {
  if (event == ARDUINO_EVENT_ETH_GOT_IP) {
    Serial.printf("[ETH] ip=%s\n", ETH.localIP().toString().c_str());
    if (!mqtt) mqttStart();  // start MQTT only once we actually have an IP
  }
}

void setup() {
  Serial.begin(115200);
  vitalQ = xQueueCreate(32, sizeof(Vital));

  Network.onEvent(onEth);                                  // 1. handler first
  ethSPI.begin(ETH_SCK, ETH_MISO, ETH_MOSI, ETH_CS);       // 2. then SPI
  if (!ETH.begin(ETH_PHY_W5500, 0, ETH_CS, ETH_IRQ, ETH_RST, ethSPI)) {
    Serial.println("[ETH] W5500 not detected — check wiring and 3V3 supply");
  }

  xTaskCreatePinnedToCore(loraTask, "lora", 4096, nullptr, 2, nullptr, 0);
  xTaskCreatePinnedToCore(netTask,  "net",  4096, nullptr, 1, nullptr, 1);
}

void loop() { vTaskDelay(pdMS_TO_TICKS(1000)); }  // all work is in tasks
```

`loop()` sengaja kosong. `esp_mqtt_client_start()` sudah membuat task sendiri,
jadi tidak ada `mqtt.loop()` yang perlu dipanggil — beda dari PubSubClient,
yang berhenti bekerja begitu `loop()` diblokir.

---

## 8. Verifikasi tanpa firmware

Sebelum menyalakan perangkat, buktikan dulu jalur backend-nya hidup. Kalau
langkah ini gagal, masalahnya bukan di firmware.

Pantau semua trafik:

```bash
mosquitto_sub -h localhost -t 'triagebox/#' -v
```

Kirim satu vital manual:

```bash
mosquitto_pub -h localhost -q 1 -t 'triagebox/st-01/node-01/vital' -m '{"victim_rfid":"9001","heart_rate":132,"spo2":88,"respiratory_rate":34,"battery":74,"triage_level":1,"confidence":93,"reasons":["hr_high"]}'
```

Cek hasilnya:

```bash
curl -s http://localhost:3001/api/victims | grep 9001
```

Jalankan simulator untuk melihat bentuk trafik yang benar dari 10 node
sekaligus — `simulator/index.js` adalah referensi cadence dan payload yang
hidup:

```bash
node simulator/index.js --stations 2 --nodes 5 --duration 60 --speed 5
```

---

## 9. Membaca log backend saat data tidak muncul

Backend selalu mencatat alasannya. Jalankan backend dengan `npm run start:dev`
dan cocokkan pesan yang muncul:

| Pesan log                                            | Artinya                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| `Received vital for node 'x' (priority: …, hr: …)`    | **berhasil** — data masuk dan diproses                     |
| `Ignored message on unhandled topic: …`               | pola topik salah; cek jumlah segmen dan ejaan `vital`       |
| `Invalid JSON payload received on topic '…'`          | JSON rusak — sering karena buffer terpotong                 |
| `Invalid vital payload for node '…': …`               | `priority` hilang, atau tipe field salah; pesan Zod menyebutnya |
| `Received vital for node '…' under unknown station …` | `station_id` belum terdaftar                               |
| `Received vital for unknown node '…' or station mismatch` | node belum terdaftar, atau terdaftar di station lain    |
| `Drop vital: unknown or inactive station '…'`         | station terdaftar tapi sudah di-soft-delete                |

Kalau tidak ada log apa pun saat station publish, MQTT-nya belum nyambung:
periksa `GET /api/health` — field `mqtt` harus `true`.

---

## 10. Checklist sebelum lapangan

- [ ] `station_id` dan semua `node_id` sudah terdaftar lewat REST atau seed
- [ ] `node_id` di topik memakai ID string terdaftar, bukan `uint8` LoRa
- [ ] Semua field numerik dikirim sebagai angka JSON, bukan string
- [ ] Key yang nilainya tidak diketahui **dihilangkan**, tidak diisi nol
- [ ] Vital tanpa `priority` tidak dipublish sama sekali
- [ ] `battery` dalam persen 0–100, bukan milivolt
- [ ] `confidence` sudah diskalakan; sentinel biner tidak lolos apa adanya
- [ ] `triage_level` dijamin 0–3 sebelum dikirim
- [ ] `timestamp` dihilangkan, atau epoch detik dari jam yang tersinkronisasi
- [ ] Buffer MQTT ≥ 512 byte (default PubSubClient 256 terlalu kecil)
- [ ] LWT terpasang: `{"status":"OFFLINE"}`, QoS 1, retained
- [ ] `{"status":"ONLINE"}` retained dipublish di event connect
- [ ] Tiap node mengirim `vital` atau `status` minimal setiap ~40 detik
- [ ] Status node membawa `rssi`, `snr`, `firmware` — tidak ada sumber lain
- [ ] Publish hanya dari satu task
- [ ] clientId unik per perangkat
- [ ] Nilai kembalian publish diperiksa dan dicatat saat gagal
- [ ] Perilaku saat kabel dicabut sudah diuji: queue menahan, lalu mengejar

---

## Referensi

- [`api-contract.md`](api-contract.md) — kontrak beku MQTT/REST/WebSocket
- `src/common/mqtt-payload.ts` — skema Zod; sumber kebenaran validasi
- `src/mqtt/mqtt.service.ts` — routing topik dan pemeriksaan identitas
- `simulator/index.js` — produsen MQTT yang benar, bisa dijadikan acuan

