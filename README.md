# 🎫 Sistem Antrian Digital SPMB

Sistem Antrian Digital SPMB adalah aplikasi manajemen antrian terpadu berbasis web yang dirancang untuk meningkatkan efisiensi, ketertiban, dan transparansi dalam proses pelayanan publik, khususnya pada proses Penerimaan Peserta Didik Baru (SPMB).

Aplikasi ini dikembangkan oleh **Cahyana Wijaya (@mrkuncen)** sebagai solusi modern untuk instansi pendidikan seperti SDN Kramat 03 PG.

## ✨ Fitur Utama

Aplikasi ini memiliki 5 modul utama yang saling terintegrasi:

1.  **🎫 Kiosk Antrian (`/kiosk`)**
    *   Antarmuka mandiri untuk pengunjung mengambil nomor antrian.
    *   Dilengkapi dengan cetak tiket fisik dan kode QR untuk verifikasi.
    *   Estimasi waktu tunggu dinamis berdasarkan beban kerja petugas.

2.  **📺 Layar Display (`/display`)**
    *   Visualisasi nomor antrian yang sedang dipanggil secara realtime.
    *   Notifikasi suara panggilan otomatis (Text-to-Speech & Chime).
    *   Videotron terintegrasi untuk menampilkan video promosi atau informasi slideshow.
    *   Peringatan jam istirahat otomatis (5 menit sebelum jeda).

3.  **🖥️ Dashboard Loket Petugas (`/loket`)**
    *   Panel khusus petugas untuk memanggil, memanggil ulang, atau melewati antrian.
    *   Filter antrian berdasarkan kategori layanan.
    *   Manajemen antrian yang dilewati (*skipped queue*).

4.  **📊 Admin Panel (`/admin`)**
    *   Statistik antrian realtime (grafik per jam).
    *   Manajemen Layanan, Loket, dan Pengguna.
    *   Pengaturan Suara (Volume, Kecepatan, Pitch).
    *   Manajemen Media (Logo, Video Slideshow, Suara Kustom).
    *   Fitur Backup Database, Log Aktivitas, dan Reset Antrian.

5.  **📤 Laporan & Export**
    *   Export data antrian harian ke format **Excel (.xlsx)**.
    *   Export laporan resmi ke format **PDF**.
    *   Export log aktivitas ke format **CSV**.

## 🚀 Teknologi yang Digunakan

*   **Backend:** Node.js
*   **Frontend:** HTML5, CSS3 (Custom utility classes), JavaScript (ES6+)
*   **Visualisasi:** Chart.js
*   **Dokumen:** SheetJS (XLSX), jsPDF
*   **Utilitas:** QRCode.js, Web Speech API (TTS), Server-Sent Events (SSE) untuk sinkronisasi realtime.

## 📦 Instalasi & Penggunaan

### Prasyarat
*   Node.js (versi 18 atau lebih baru)
*   NPM (Package Manager)

### Langkah Instalasi
1.  Clone atau download repository ini.
2.  Buka terminal di direktori proyek.
3.  Install dependensi:
    ```bash
    npm install
    ```
4.  Jalankan aplikasi:
    ```bash
    npm start
    ```
5.  Akses melalui browser:
    *   **Kiosk:** `http://localhost:3000/kiosk`
    *   **Display:** `http://localhost:3000/display`
    *   **Admin/Loket:** `http://localhost:3000/login`

## 🛠️ Build Executable (Windows)

Proyek ini telah dikonfigurasi menggunakan `pkg` untuk dikompilasi menjadi file executable tunggal:

```bash
npm run build
```
Hasil build akan menghasilkan file `antrian_spmb.exe` di direktori root.

## 🔐 Keamanan & Lisensi

Sistem ini dilengkapi dengan modul autentikasi dan manajemen hak akses (Admin & Petugas). Seluruh aktivitas sensitif dicatat dalam **Log Aktivitas** untuk keperluan audit.

**© 2026 Cahyana Wijaya** · Dikembangkan untuk SDN Kramat 03 PG.
TikTok: [@mrkuncen](https://www.tiktok.com/@mrkuncen)
