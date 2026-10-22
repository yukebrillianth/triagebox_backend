# Interval waktu sistem TriageBox

Satu tabel untuk semua interval yang memengaruhi seberapa segar data di dasbor.
Nilai di kode/konfigurasi adalah sumber kebenaran; dokumen ini menjelaskan
hubungannya. Kalau mengubah satu nilai, periksa aturan di bawah.

| Parameter | Di mana | Nilai | Catatan |
|---|---|---|---|
| Jendela pengukuran awal (gelombang EKG/PPG untuk BP) | ESP32, `UI_MEASURE_MS_DEFAULT` (`ui_mock.h`) | **45 s** | Nilai di kode. Dokumen lama menyebut 60 s; itu salah. Dasar angkanya ada di komentar `ui_mock.h` (jendela 30 s → galat BP lebih besar). RR bukan dari jendela ini: berasal dari input petugas. |
| Klasifikasi ulang saat monitoring | ESP32, `UI_RETRIAGE_DEFAULT_MS` + Menu | **30 s** default; 15 / 30 / 60 s / Mati | Tersimpan di NVS (`ui_settings`); tetap setelah reboot. |
| Siklus poll station → semua node | station, `CONFIG_TB_POLL_PERIOD_MS` | **15 s** (deployment) | Uji jarak boleh 2–3 s, lalu kembalikan. Backend membacanya dari `STATION_POLL_PERIOD_SEC`. |
| Slot satu node dalam siklus | station, `LORA_POLL_SLOT_MS` | 250 ms | Node absen memakan satu slot penuh. |
| Node dianggap OFFLINE (backend) | `NODE_OFFLINE_SEC`, dicek tiap 15 s oleh `OfflineService` | **45 s** | Aturan 2 di bawah. |
| Node dianggap putus (station) | `LORA_POLL_MISS_LIMIT` luput berturut-turut | 3 siklus | Station mem-publish OFFLINE retained. |
| Indikator link basi di layar node | ESP32, `LINK_STALE_MS` (satu definisi di `ui_status.h`) | **45 s** | Dulu dua salinan (`ui_status.c`, `tb_ui_source.c`) tanpa jaminan sama; sekarang satu. |
| Tekanan darah | ESP32, sekali di awal pengukuran lalu di-latch | tidak diestimasi ulang | Dasbor menampilkan `bpMeasuredAt` supaya TD lama tidak terlihat live. |
| Vital ke dasbor | station → MQTT | tiap siklus (15 s) | Vital ditahan bila node belum punya skor. |

## Aturan yang dijaga

1. **Klasifikasi ulang >= siklus poll.** Hasil antara yang lebih cepat dari satu siklus tidak pernah sampai ke dasbor. Pilihan Menu terkecil (15 s) = siklus deployment (15 s); `ui_settings_selftest` memastikan semua pilihan non-nol >= `UI_RETRIAGE_MIN_MS` (15 s, sama dengan `LORA_POLL_PERIOD_MS` station).
2. **`NODE_OFFLINE_SEC` >= 3 × siklus poll.** Satu balasan LoRa hilang itu normal; di bawah tiga siklus node sehat berkedip OFFLINE/ONLINE dan membanjiri alert. Backend **menolak start** bila dilanggar (`assertTimingInvariants`, diuji di `npm run check:logic`).
3. **`LINK_STALE_MS` hanya didefinisikan sekali** di firmware ESP32 (`ui_status.h`), jadi layar node dan logika status tidak bisa berbeda.
4. **Siklus 20 node muat dalam periode.** 20 × (250 ms slot + jeda) ≈ 5,6 s < 15 s; station menolak konfigurasi yang tidak muat.
5. **Siklus kerja radio.** Periode 15 s dengan 20 node ≈ 4%; di bawah 8 s dengan banyak node melewati batas ~10% yang dipakai dokumen station.

`GET /api/settings` mengembalikan blok `timing` (`pollPeriodSec`, `nodeOfflineSec`, `linkStaleSec`) untuk halaman Pengaturan dasbor. Interval klasifikasi ulang hidup di node, bukan di backend, jadi tidak ada di blok itu.
