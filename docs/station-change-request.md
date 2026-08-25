# Perubahan integrasi station ESP32 — sudah diterapkan

Untuk: Andika (pemilik `triagebox_esp32_station`)
Dari: sisi backend + dashboard, sebagai system integrator
Tanggal: 2026-08-21

**Semua perubahan di bawah sudah saya terapkan langsung di repo station**, atas
persetujuan project leader. Dokumen ini alasannya, supaya tidak ada yang terlihat
seperti perubahan sewenang-wenang. Kontrak di `docs/mqtt-contract.md` dan
`docs/lora-air-protocol.md` di repo station sudah ikut diperbarui.

Ringkasan: 4 perbaikan integrasi (2 di antaranya saling bergantung), 1 koreksi
klaim daya pancar, dan 1 tool baru yang mengubah pertanyaan "setting radio mana
yang terbaik" dari opini jadi aritmetika.

---

## Yang sudah diperbaiki di backend (tidak perlu diapa-apakan)

Saya compile `main/tb_vital_json.c` di host, generate JSON untuk enam keadaan yang
hardware benar-benar capai, lalu masukkan tiap output ke skema Zod backend yang
asli. Hasil sebelum perbaikan:

| Keadaan node | Hasil | Field yang bikin ditolak |
| --- | --- | --- |
| Ada skor, gauge belum terbaca, tanpa tag | REJECT | `victim_rfid`, `battery` |
| Ada skor, tag terbaca | REJECT | `battery` |
| Ada gauge + jam tersinkron | accept | — |
| Belum diskor (baru boot) | REJECT | `victim_rfid`, `battery`, `confidence` |
| Sensor belum siap | REJECT | `victim_rfid`, `spo2`, `battery`, `confidence` |
| Sensor SpO2 mati | REJECT | `spo2` |

Lima dari enam ditolak, dan yang lolos justru satu-satunya yang hardware saat itu
belum bisa hasilkan.

Prinsip "keys are omitted, never zeroed" di `tb_vital_json.c:71` **benar** dan
backend yang mengalah: `victim_rfid`, `hr`, `spo2`, `rr`, `battery`, dan
`confidence` sekarang opsional, dan kolom databasenya nullable. Alasan yang kamu
tulis di sana — 0 hr itu pasien meninggal, 0 battery itu node mati — persis alasan
kenapa memaksa nilai pengganti akan lebih buruk.

Saya juga konfirmasi ke sumbernya, bukan cuma ke dokumen: `main.c` di
`triagebox_stm32_node` memang mengirim `0xFF /* battery: not measured on this
board */`, jadi `battery` bukan kadang-kadang absen — selalu.

**Koreksi, 2026-08-25:** alasannya bukan "tidak ada fuel gauge". Board node punya
PMIC SW6106 dengan fuel gauge sungguhan di I²C `0x3c`, dibaca
`ui_board_battery()` dan sudah tampil di LCD node. Masalahnya arah: gauge itu ada
di sisi ESP32, sementara paket LoRa dibangun STM32, dan peta register tidak punya
jalur untuk menyeberangkannya. Sudah diperbaiki dengan satu register baru
(`TB_REG_HOST_BATTERY 0x43`) — ESP32 menuliskan persennya, STM32 memakainya untuk
`lora_vital.battery`. Jadi `battery` sekarang nyata; yang tetap benar adalah
`battery` harus opsional, karena 0xFF masih muncul di detik-detik pertama setelah
boot dan saat pembacaan PMIC gagal.

Ada regression check permanen di backend (`npm run check:station`) yang memuat
keenam output itu, jadi kalau backend memperketat skemanya lagi, itu ketahuan
sebelum sampai ke hardware.

---

## 1. Vital yang belum diskor tidak dipublish

`priority` adalah satu-satunya field yang tetap wajib. Ia menggerakkan triase,
KPI, donut, dan alert; baris tanpa priority tidak punya makna di sistem ini.

`lora_vital.h:61` sudah menyatakan station harus menghilangkan `priority` dan
`confidence` saat melihat `0xFF`. Aturan lanjutannya: kalau keduanya hilang,
paketnya tidak layak dipublish sama sekali.

Diterapkan di `main/station_poll.c`, `poll_one()`, sebelum `tb_vital_json()`:

```c
if (lora_vital_priority_name(v->priority) == NULL) {
	ESP_LOGD(TAG, "node %u unscored, vital withheld", node_id);
	return;
}
```

Node tetap ONLINE — ia menjawab poll. Yang tidak dikirim hanya vitalnya, dan
biayanya kecil: saya cek `main.c:609` di repo node, `mon_priority` **sticky** —
sekali ESP32 memberi skor, nilainya bertahan sampai skor berikutnya. Jadi keadaan
unscored hanya terjadi di beberapa siklus pertama setelah node boot.

## 2. Node status dipublish setiap siklus, bukan hanya saat transisi

Ini konsekuensi langsung dari #1, dan **tanpanya #1 menimbulkan bug yang lebih
buruk dari yang diperbaikinya** — jadi keduanya harus jalan bersama.

`lastSeen` node di backend hanya disegarkan oleh vital atau node status, dan
backend menandai node OFFLINE setelah 45 detik tanpa keduanya
(`NODE_OFFLINE_SEC`, disapu tiap 15 detik). Sebelumnya node status hanya dipublish
saat transisi. Jadi:

1. Node belum diskor lebih dari 45 detik → vitalnya disuppress oleh #1.
2. Backend menandainya OFFLINE.
3. Dari sisi station tidak ada transisi — `s_online[node_id]` masih `true`.
4. **Tidak ada apa pun yang akan mempublish ONLINE lagi.** Node hidup yang
   menjawab setiap poll tampak mati selamanya di dashboard.

Kasusnya bukan hipotetis: node yang MAX30102-nya mati tidak akan pernah dapat
skor, jadi tidak akan pernah punya vital yang layak dikirim.

Perbaikannya persis yang sudah kamu tawarkan sendiri di komentar
`station_poll.c:76` — `publish_status_online()` sekarang dipanggil setiap siklus
untuk node yang menjawab, bukan hanya saat `!s_online[node_id]`. `OFFLINE` tetap
transisi-saja, karena di situ tidak ada nilai baru untuk dilaporkan. Biayanya satu
pesan per node per 15 detik (20 node = 1,3 pesan/detik), dan bonusnya `rssi`/`snr`
di dashboard jadi nilai sekarang, bukan nilai sejak node itu naik.

## 3. Publish announce supaya station bisa diadopsi dari dashboard

Sekarang station yang ID-nya belum terdaftar di database dibuang senyap, dan tidak
ada apa pun di dashboard yang menunjukkan ada perangkat mencoba masuk. Untuk 20
node itu 21 request `curl` manual, dan satu salah ketik = paket hilang tanpa jejak.

Backend sekarang punya alur adopsi ala UniFi. Yang dibutuhkan dari station: satu
publish tambahan di `MQTT_EVENT_CONNECTED`, tepat setelah status ONLINE.

- Topik: `triagebox/{station_id}/announce`
- QoS 1, **retained** (supaya dashboard yang dibuka belakangan tetap melihatnya)

```json
{
  "station_id": "st-01",
  "mac": "AA:BB:CC:DD:EE:FF",
  "ip": "192.168.50.11",
  "firmware": "1.0.0",
  "node_count": 20
}
```

`station_id` dan `mac` wajib; `ip`, `firmware`, `node_count` opsional.

MAC-nya diambil dari `esp_read_mac(macaddr, ESP_MAC_ETH)` yang sudah ada di
`station_net_start()`, disimpan sebagai string statik supaya `mqtt_start()` bisa
memformatnya sekali. IP-nya dari `got_ip_handler` (jadi jalur static dan DHCP
mengisi announce dengan cara yang sama).

Ini **tidak** membuat Station di database. Announce masuk sebagai kandidat
`PendingStation` (kunci: MAC), muncul di panel "Menunggu adopsi" di halaman
Perangkat, dan operator menekan Adopt sekali untuk membuat station plus semua
nodenya. Jadi jaminan "MQTT never creates a device" tetap berlaku — hanya
pintunya sekarang kelihatan.

Yang penting untuk station: **`node_count` menentukan jumlah node yang dibuat**,
dan ID-nya digenerate `node-NN` dari angka yang sama yang firmware pakai di
`snprintf("node-%02u")`. Itu menutup jebakan yang kamu catat sendiri di
`station_net.h:31` — ID di kedua sisi dijamin cocok karena diturunkan dari satu
angka.

Announce yang `station_id`-nya sudah terdaftar diabaikan (bukan error), jadi aman
dipublish tiap reconnect. Payload-nya dibangun sekali di `mqtt_start()`, bukan di
handler, karena `MQTT_EVENT_CONNECTED` jalan di task esp-mqtt dan tidak boleh
mengerjakan string atau membaca netif.

## 4. IP hardcoded diganti satu nomor per board

`sdkconfig.defaults` mem-hardcode `CONFIG_TB_ETH_IP="192.168.50.50"` dan file itu
**di-commit**. Station kedua yang di-flash dari repo yang sama langsung bentrok
IP, dan gejalanya menyesatkan: ARP berebut, MQTT connect lalu putus bergantian,
tanpa pesan apa pun yang menyebut "IP conflict".

DHCP bukan jalan keluar untuk deployment ini: di lapangan bencana tidak ada
router, dan Windows desktop tidak punya DHCP server (role itu hanya ada di Windows
Server; ICS memaksa subnet `192.168.137.x` yang tidak bisa diubah tanpa registry,
plus butuh koneksi internet untuk "dibagi"). Topologi minimum untuk multi-station
adalah satu switch unmanaged — tanpa DHCP, tanpa konfigurasi.

Sekarang satu `CONFIG_TB_STATION_NUM` (1..20) jadi asal semua identitas yang bisa
bentrok senyap:

```
TB_STATION_NUM = N
  → IP           <TB_ETH_SUBNET>.(10 + N)   → .11, .12, .13, …
  → LoRa addr    N                          (menggantikan TB_STATION_ADDR)
  → node id base (N - 1) * 20               → st 1: node-01.., st 2: node-21..
```

`TB_STATION_ID` tetap string sendiri, karena ia harus cocok dengan yang terdaftar
di backend dan **salahnya berbunyi**: backend mencatat station tidak dikenal dan
dashboard menampilkannya sebagai menunggu adopsi. Yang saya satukan hanya yang
salahnya senyap.

Node id base itu temuan terpisah yang penting: firmware dulu selalu mem-poll
alamat radio 1..N dan memformat topiknya langsung dari alamat itu, jadi station
kedua akan mempublish `node-01` juga — dan **semua datanya dibuang** oleh backend
karena `node-01` terikat ke station pertama, meski radionya sempurna. Alamat radio
tetap 1..20 di setiap station (jadi firmware node tidak berubah); yang bergeser
hanya ID di topik.

Kenapa bukan "IP di-push dari dashboard setelah adopt", yang kamu tanyakan:
station harus sudah bisa bicara dengan broker untuk *menerima* IP-nya. Kalau IP
awalnya bentrok, ia tidak akan pernah sampai ke titik itu. UniFi lolos dari masalah
ini karena AP-nya DHCP dulu lalu di-set static setelah adopt — dan DHCP itulah yang
tidak kita punya. Satu angka per board juga membuat bentroknya bergejala: dua board
dengan nomor sama ikut bentrok di alamat radio, yang muncul di log sebagai
`polled N, node M answered`.

`sdkconfig.defaults` sudah diberi blok komentar bahwa `TB_STATION_NUM` harus
diubah per board.

---

## Yang sudah cocok dan tidak perlu disentuh

Tiga dari empat bagian kontrak sudah persis benar, diverifikasi dengan menjalankan
output firmware terhadap skema backend:

- **Pola topik**, termasuk `node-%02u` — `parseTopic` menerima ketiganya.
- **Station status + LWT** — `{"status":"OFFLINE"}` retained QoS 1 sudah tepat,
  termasuk koreksi dari bare-string ke JSON yang kamu lakukan 2026-08-18.
- **Node status** — ketiga varian (`ONLINE` dengan/tanpa battery, `OFFLINE`
  telanjang) lolos validasi.

## Pertanyaan terbuka dari `docs/mqtt-contract.md`, dijawab

**`ts` dihilangkan dan backend menstempel waktu terima — dikonfirmasi, itu yang
benar.** Bukan cuma "acceptable": kalau `ts` bernilai `< 1e12` backend
memperlakukannya sebagai epoch detik, jadi `millis()` = 45000 dibaca sebagai
`1970-01-01T12:30:00Z`. Paketnya **tidak** ditolak — `VitalReading` tetap
tersimpan, tapi snapshot korban dilewati karena timestamp-nya lebih tua dari
`lastUpdate`. Gejalanya: riwayat vital bertambah, prioritas korban membeku. Jadi
mengirim jam yang belum tersinkron lebih buruk daripada tidak mengirim apa pun,
persis seperti yang `station_poll.c:37` sudah simpulkan. Jangan tambahkan SNTP
untuk keperluan ini.

**`reasons` boleh absen — dikonfirmasi.** Default-nya `[]` di backend. Tidak perlu
dikirim.

**`packet_counter` dan `device_status` ditoleransi — dikonfirmasi.**
`device_status` disimpan di baris pembacaan. `packet_counter` diterima tapi
**belum disimpan** — backend memakai `{ increment: 1 }` sendiri untuk
`Node.packetCount`, jadi deteksi gap yang jadi alasan field itu ada belum bisa
dilakukan dari dashboard. Perbaikannya sebaris di backend dan ada di daftar; tetap
kirim field-nya.

**Anonymous access, TLS, ACL per station:** belum diperlukan untuk bench
terisolasi, dan itu berubah begitu jaringannya dibagi. Belum ada yang dikerjakan
di sisi backend.

---

## 5. Koreksi: radio berjalan di 17 dBm, bukan 20 dBm

Bukan perubahan perilaku — perubahan komentar, tapi yang isinya penting.

Kedua ujung menulis `RegPaConfig = 0xFF` dan tidak ada yang menulis `RegPaDac`
(0x4D). Pada nilai reset-nya (`0x84`) mode +20 dBm **mati**, jadi PA_BOOST berhenti
di **+17 dBm** apa pun isi `RegPaConfig`. Untuk benar-benar 20 dBm butuh
`RegPaDac = 0x87` **dan** OCP dinaikkan ke ~140 mA, dan datasheet §5.4.3 lalu
membatasi transmisi ke **duty cycle 1%** dengan VSWR di bawah 3:1.

Jadi konfigurasi sekarang koheren dan benar — hanya bukan 20 dBm seperti yang
diklaim komentarnya dan nama konstanta `POWER_20db` di library node.

**Sengaja tidak saya ubah.** Station sudah memancar 4,1% duty saat mem-poll 20
node, jauh di atas plafon 1% yang disyaratkan +20 dBm. Mengaktifkannya berarti
mengoperasikan PA di luar spesifikasi untuk 3 dB — sekitar 1,26× jarak di n=3 — dan
kegagalannya berupa PA terpanggang, bukan peringatan. Yang saya perbaiki adalah
komentar di `sx1278.c` yang menyesatkan.

Kalau butuh jarak, naikkan spreading factor: 2,5 dB per langkah, dan tool di
bawah menunjukkan biayanya.

## 6. Tool baru: `tools/lora_budget.c`

Setting radio sekarang berasal dari default konstruktor `newLoRa()` di library
node — tidak ada yang memilih SF7/BW125/CR4-5, itu kebetulan apa yang
diinisialisasi library. Setiap pertanyaan yang penting soal itu ("bisa lebih
jauh?", "bisa lebih cepat?", "duty cycle-nya aman?") sebenarnya aritmetika, dan
aritmetika yang belum pernah dikerjakan.

```bash
tools/run_selftests.sh   # tb_vital_json + lora_budget
```

Semua rumusnya dari datasheet SX1276/78 §4.1.1 dan §6.4. Tiga angka airtime yang
sudah tertulis di `lora-air-protocol.md` (~31 ms poll, ~51 ms vital kosong, ~82 ms
vital bertag) sekarang **di-assert** oleh tool itu, jadi kalau dokumen dan rumus
berbeda, build-nya gagal.

Temuan yang paling berguna, dan hasilnya berlawanan dengan dugaan awal: **slot
bukan dibatasi airtime, tapi dibatasi deadline node.**

| Komponen satu slot | ms | Porsi |
| --- | --- | --- |
| Airtime balasan (vital bertag) | 82 | 35% |
| `LORA_REPLY_DEADLINE_MS` node | 150 | 63% |
| Peralihan RX→TX | ~5 | 2% |

Dua pertiga tiap slot habis menunggu node menyadari poll yang sudah diterimanya.
150 ms itu ada karena node memeriksa DIO0 sekali per pass superloop dan scan PN532
memblokir ~120 ms di dalam pass itu — properti firmware, bukan radio. Artinya
peningkatan jarak yang paling murah bukan setting radio sama sekali.

Siklus 20 node di SF7 hanya 5,6 s dari periode 15 s, jadi periodenya lapang;
yang sempit adalah slot — 237 ms terpakai dari 250 ms, sisa 13 ms.

| Config | Sensitivitas | Budget | Jarak × (n=3) | Butuh |
| --- | --- | --- | --- | --- |
| SF7/BW125 (sekarang) | −124,5 dBm | — | 1,00 | pas, slot 237 ms |
| SF9/BW250 | −126,5 dBm | +2,0 dB | 1,16 | deadline node ≤70 ms |
| SF9/BW125 | −129,5 dBm | +5,0 dB | 1,47 | slot ~430 ms |
| SF10/BW125 | −132,0 dBm | +7,5 dB | 1,78 | siklus 18 s — **tidak masuk** |
| SF12/BW125 | −137,0 dBm | +12,5 dB | 2,61 | siklus 59 s, duty 110% — **mustahil** |

CR4/8 tidak dipakai: +45% airtime untuk **0 dB** sensitivitas (itu koreksi galat,
bukan penguatan sinyal).

**Setting radionya tidak saya ubah.** Menaikkan SF harus serempak di kedua
firmware plus mengubah `LORA_POLL_SLOT_MS`, dan angka jarak di atas relatif — jarak
absolut di 433 MHz dekat tanah ditentukan halangan, bukan eksponen. Ukur sekali di
SF7, lalu skalakan pakai tabel itu. Keputusannya milik kamu; sekarang ada
angkanya.

Satu asimetri lain yang ketemu dan saya catat tapi tidak ubah: node tidak pernah
menyalakan `AgcAutoOn` (`RegModemConfig3` reset-nya 0x00 dan `setAutoLDO()` hanya
menyentuh bit LDRO), sementara station menulis 0x04. Jadi node memakai LNA gain
maksimum tetap dan station memakai AGC. Menguntungkan node di jarak jauh, bisa
menjenuhkannya di jarak dekat, dan belum pernah diukur.

Juga latent trap kalau SF dinaikkan ke 11/12: station menulis `RegModemConfig3`
secara blind tanpa bit LDRO, sedangkan node menghitungnya sendiri lewat
`setAutoLDO()`. Beda satu bit di register itu bikin dua radio yang kelihatan benar
tidak saling dengar. Sudah saya tulis di komentarnya.

## Cara menguji tanpa hardware

Publish JSON persis seperti yang firmware hasilkan sekarang:

```bash
mosquitto_pub -h localhost -q 1 -t 'triagebox/st-01/node-01/vital' \
  -m '{"hr":118,"spo2":91,"rr":28,"priority":"RED","confidence":0.87,"packet_counter":1421,"device_status":0}'
```

Sebelum perbaikan backend ini memunculkan `Invalid vital payload`; sekarang
`Ingested vital for RFID ...` dan korbannya muncul di `/api/victims` dengan
`battery: null`.

Untuk adopsi:

```bash
mosquitto_pub -h localhost -q 1 -r -t 'triagebox/st-01/announce' \
  -m '{"station_id":"st-01","mac":"AA:BB:CC:DD:EE:FF","ip":"192.168.50.11","firmware":"1.0.0","node_count":20}'
```

Kandidatnya harus muncul di `GET /api/stations/pending` dan di panel "Menunggu
adopsi" pada `/perangkat`. Alur lengkapnya sudah saya uji end-to-end lewat
browser: announce → pending → Adopt → node terbentuk → vital diterima.

## Yang belum diuji

Bagian ESP-IDF-nya **belum dikompilasi** — tidak ada toolchain ESP-IDF di mesin
ini, jadi `station_net.c` dan `station_poll.c` perlu kamu build sekali di board
asli. Yang sudah diverifikasi di host: aritmetika identitas turunan
(`TB_STATION_NUM` → IP, alamat radio, rentang node id), `tb_vital_json` lewat
self-test yang sudah ada, dan seluruh rumus radio.

## Referensi

- `docs/api-contract.md` — kontrak beku, sudah diperbarui dengan aturan
  required/optional dan topik announce
- `docs/station-firmware-mqtt.md` — panduan sisi firmware, sudah diperbarui
- `src/common/mqtt-payload.ts` — skema Zod, sumber kebenaran validasi
- `scripts/check-station-payload.ts` — regression check enam skenario itu
