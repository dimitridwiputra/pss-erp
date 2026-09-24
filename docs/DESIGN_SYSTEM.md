# PSS Operating Platform — Design System & UX Standard 1.0

**Status:** Baseline untuk implementasi Greenfield  
**Bahasa produk:** Bahasa Indonesia  
**Bahasa kode/identifier:** English  
**Acuan visual:** Logo PSS / Putra Sumber Sari dan Business Overview September 2026  
**Acuan UX:** PSS Operating Platform Architecture PRD 1.0, khususnya prinsip “model complexity, do not expose it”, WMS `SCAN → CONFIRM → NEXT`, role-scoped applications, offline-first field usage, dan exception-driven operations.

---

## 1. Tujuan

PSS Operating Platform harus mampu digunakan oleh pengguna dengan tingkat literasi digital dan pendidikan formal yang beragam tanpa mengorbankan kemampuan backend, kontrol internal, auditability, atau skalabilitas.

Prinsip utamanya:

> **Backend boleh kompleks. Pengguna tidak boleh merasakan kompleksitasnya.**

Sistem tidak didesain sebagai “ERP yang harus dipelajari”. Sistem didesain sebagai **alat kerja yang memberi tahu pengguna apa yang harus dilakukan berikutnya**.

Target desain:

- Pengguna baru dapat menyelesaikan ≥80% pekerjaan rutin setelah onboarding aplikasi ≤10 menit.
- Satu layar operasional hanya memiliki satu tujuan utama.
- Maksimum 3 aksi primer/sekunder yang terlihat pada satu waktu.
- Setiap layar memiliki satu *next action* yang jelas.
- Free text bukan input utama; gunakan scan, pilih, foto, dan default.
- Bahasa sistem, state machine, integrasi, dan akuntansi tidak diekspos bila tidak relevan dengan pekerjaan pengguna.
- Error selalu menjelaskan **apa yang terjadi + apa yang harus dilakukan**.
- Offline dan koneksi buruk dianggap kondisi normal untuk Sales dan Driver.
- Role menentukan pengalaman produk, bukan hanya permission.

---

## 2. PSS UX Constitution

Aturan berikut **wajib** dan harus dianggap sebagai acceptance criteria UI.

### UX-01 — Satu layar, satu pekerjaan
Jangan gabungkan workflow berbeda dalam satu layar operasional. Bila pengguna sedang melakukan picking, layar tidak boleh sekaligus menawarkan edit customer, lihat piutang, atau edit harga.

### UX-02 — Satu tindakan berikutnya yang jelas
Setiap layar harus menjawab: **“Saya harus melakukan apa sekarang?”**

### UX-03 — Scan → Pilih → Konfirmasi → Foto → Ketik
Urutan preferensi input:
1. Scan QR/barcode.
2. Pilih dari opsi terbatas.
3. Konfirmasi default yang sudah disarankan sistem.
4. Foto/unggah bukti.
5. Ketik manual hanya bila tidak ada alternatif.

### UX-04 — Jangan tampilkan state machine
State teknis seperti `PARTIALLY_FULFILLED`, `PENDING_RECONCILIATION`, atau `CREDIT_HOLD` diterjemahkan menjadi bahasa kerja seperti:
- “Sebagian barang belum tersedia”
- “Pembayaran perlu dicek”
- “Pesanan perlu persetujuan”

### UX-05 — Sistem memberi default yang paling mungkin benar
Pengguna mengelola pengecualian, bukan mengisi seluruh form dari nol.

### UX-06 — Error harus actionable
Dilarang menampilkan hanya `Error 422`, `Validation Failed`, atau stack trace.

Gunakan pola:

**Barang tidak cocok**  
Barang yang dipindai bukan barang yang diminta.  
`[SCAN ULANG]`

### UX-07 — Role menentukan produk
Sales, Picker, Driver, Finance, Admin, Supervisor, dan Management tidak menggunakan dashboard yang sama dengan menu yang disembunyikan. Mereka mendapatkan pengalaman kerja yang berbeda.

### UX-08 — Pekerjaan rutin tidak membutuhkan manual book
Workflow harian harus self-explanatory melalui label, urutan langkah, default, dan feedback UI.

### UX-09 — Offline adalah keadaan normal
Sales dan Driver harus tetap dapat melakukan pekerjaan yang telah di-*cache* dan melihat status sinkronisasi secara sederhana.

### UX-10 — Kompleksitas backend tidak boleh bocor ke frontend
Tidak boleh menambahkan field, pilihan, atau layar hanya karena backend memiliki atribut tersebut.

### UX-11 — Exception-driven
Aplikasi mengarahkan pengguna ke pekerjaan dan pengecualian yang perlu ditindaklanjuti. Jangan mengharuskan pengguna “mencari” masalah melalui laporan.

### UX-12 — Progressive disclosure
Informasi lanjutan hanya dibuka bila diperlukan atau pengguna memiliki role yang relevan.

---

## 3. Identitas Visual PSS

### 3.1 Karakter visual

Logo PSS menggabungkan **merah kuat** dan **navy gelap** dengan bentuk geometris, lugas, dan industrial. Sistem UI harus menerjemahkan karakter tersebut menjadi:

- tegas;
- praktis;
- terpercaya;
- tidak dekoratif berlebihan;
- fokus pada tugas;
- kontras tinggi;
- mudah dipindai secara visual.

Hindari gaya fintech yang terlalu glossy, gradient-heavy, glassmorphism, atau dashboard penuh kartu dekoratif.

### 3.2 Warna brand utama

Warna berikut diambil dari visual logo/deck PSS dan dinormalisasi menjadi token UI.

```css
:root {
  --pss-navy-900: #0A2359;
  --pss-navy-950: #041D54;
  --pss-red-600:  #EA0711;
  --pss-cream-50: #F6F5F0;
  --pss-white:    #FFFFFF;
}
```

**Penggunaan:**
- Navy = primary brand/action/navigation.
- Red = brand accent, destructive, critical attention. Jangan gunakan red untuk semua CTA.
- Cream/off-white = background utama desktop dan halaman non-operasional.
- White = surface/kartu/form.

### 3.3 Neutral palette

```css
--gray-950: #111827;
--gray-900: #1F2937;
--gray-700: #374151;
--gray-600: #4B5563;
--gray-500: #6B7280;
--gray-400: #9CA3AF;
--gray-300: #D1D5DB;
--gray-200: #E5E7EB;
--gray-100: #F3F4F6;
--gray-50:  #F9FAFB;
```

### 3.4 Semantic colors

Semantic color harus independen dari brand color.

```css
--success-700: #15803D;
--success-100: #DCFCE7;

--warning-700: #A16207;
--warning-100: #FEF3C7;

--danger-700: #B91C1C;
--danger-100: #FEE2E2;

--info-700: #1D4ED8;
--info-100: #DBEAFE;
```

Aturan:
- Jangan bergantung pada warna saja; selalu sertakan ikon + label.
- Red brand tidak otomatis berarti error.
- Status “Perlu Dicek” sebaiknya amber, bukan merah, kecuali memang berisiko tinggi atau blocking.

---

## 4. Tipografi

### 4.1 Font

Gunakan **Inter** sebagai font UI utama.

Alasan:
- keterbacaan tinggi pada layar kecil;
- numerik jelas;
- mendukung banyak weight;
- umum dan stabil untuk web/PWA;
- mudah untuk manusia dan Coding Agent.

Fallback:

```css
font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

### 4.2 Skala tipografi

| Token | Desktop | Mobile | Weight | Penggunaan |
|---|---:|---:|---:|---|
| `display` | 40/48 | 32/40 | 700 | Angka/dashboard penting |
| `h1` | 32/40 | 28/36 | 700 | Judul halaman |
| `h2` | 24/32 | 22/30 | 700 | Section utama |
| `h3` | 20/28 | 20/28 | 600 | Subsection |
| `body-lg` | 18/28 | 18/28 | 500 | Instruksi kerja |
| `body` | 16/24 | 16/24 | 400 | Default |
| `label` | 14/20 | 14/20 | 600 | Field/status |
| `caption` | 12/16 | 12/16 | 500 | Metadata |

Aturan mobile operasional:
- Tidak boleh ada teks utama <16 px.
- Instruksi utama ≥18 px.
- Nomor kuantitas, uang, nomor urut, rak, dan kode penting gunakan `font-variant-numeric: tabular-nums`.

---

## 5. Spacing, Radius, Elevation

Gunakan basis 4 px.

```text
4   xs
8   sm
12  md
16  lg
24  xl
32  2xl
48  3xl
64  4xl
```

Radius:

```text
6 px   input kecil / badge
8 px   default component
12 px  task card / panel
16 px  mobile action card
999 px pill/status only
```

Shadow minimum:

```css
--shadow-sm: 0 1px 2px rgba(17,24,39,.06);
--shadow-md: 0 4px 12px rgba(17,24,39,.08);
```

Jangan gunakan shadow sebagai satu-satunya pembeda struktur. Gunakan border, spacing, dan hierarchy.

---

## 6. Layout System

### 6.1 Desktop
- Max content width dashboard: 1440 px.
- Sidebar: 240–280 px untuk role administratif; collapsible.
- Content gutter: 24–32 px.
- Grid: 12 kolom.
- Data table boleh full width.

### 6.2 Mobile operasional
- Full-width single-column.
- Horizontal padding: 16 px.
- Bottom safe area diperhitungkan.
- Primary action sticky di bawah jika workflow memerlukan konfirmasi.
- Maksimum 2 primary action pada layar driver; maksimum 3 action umum.

### 6.3 Touch target
Minimum **48×48 px** untuk semua target utama mobile.

Scanner/warehouse mode disarankan 56–64 px untuk tombol primer karena penggunaan sambil bergerak / memakai sarung tangan.

---

## 7. Navigation

### 7.1 Role-based navigation

#### Sales
Bottom navigation maksimal 4 item:
- Hari Ini
- Toko
- Tagihan
- Saya

#### Gudang
Tidak perlu bottom navigation kompleks. Default ke **Antrian Kerja**.
- Tugas
- Scan
- Masalah
- Saya

#### Driver
- Rute Hari Ini
- Bukti
- Saya

#### Finance/Admin desktop
Sidebar berbasis pekerjaan, bukan struktur database:
- Hari Ini
- Pesanan
- Pengiriman
- Piutang
- Pembayaran
- Keuangan
- Persediaan
- Data Utama
- Perlu Ditindaklanjuti
- Laporan

#### Management
- Ringkasan
- Penjualan
- Persediaan
- Piutang
- Kas
- Keuangan
- Operasional
- Pengecualian

### 7.2 Jangan tampilkan menu tanpa value
Permission deny = menu tidak muncul, bukan menu disabled massal.

---

## 8. Component Library

Implementasi UI menggunakan:
- Tailwind CSS untuk token/utilities;
- Radix UI primitives;
- shadcn/ui sebagai starting component source;
- class-variance-authority untuk variant;
- Lucide Icons untuk ikon;
- React Hook Form + Zod untuk form;
- TanStack Query untuk server state;
- TanStack Table untuk table kompleks;
- Recharts untuk chart standar.

Jangan membuat komponen dasar custom bila library matang sudah mencukupi.

### 8.1 Button

Variant wajib:
- `primary` — navy.
- `secondary` — white/navy border.
- `danger` — red.
- `ghost` — low emphasis.
- `success` — hanya action konfirmasi tertentu.

Size:
- desktop default: 40 px.
- mobile default: 48 px.
- warehouse/driver primary: 56 px.

Label harus berupa kata kerja:
- `Simpan`
- `Konfirmasi`
- `Scan Ulang`
- `Mulai Kunjungan`
- `Kirim ke Atasan`

Hindari: `OK`, `Submit`, `Process`.

### 8.2 Task Card

Komponen paling penting bagi aplikasi operasional.

Harus memiliki:
- apa yang harus dilakukan;
- objek kerja;
- konteks minimum;
- prioritas/status;
- satu CTA utama.

Contoh:

```text
AMBIL BARANG

Milo 1 kg
4 Karton
Rak A-12

[ MULAI ]
```

### 8.3 Status Pill
Gunakan bahasa manusia.

Contoh vocabulary:

```text
Siap Diproses
Sedang Diproses
Perlu Dicek
Menunggu Persetujuan
Selesai
Gagal
Terlambat
Belum Sinkron
```

### 8.4 Inputs
- Label selalu terlihat; jangan hanya placeholder.
- Helper text hanya bila membantu aksi.
- Format rupiah otomatis.
- Format quantity menampilkan UOM.
- Search/select mendukung keyboard dan mobile.
- Required field ditandai secara eksplisit.

### 8.5 Selection Card
Untuk pilihan penting di mobile gunakan kartu besar, bukan dropdown kecil.

```text
Kondisi barang?

[ ✓ BAIK ]
[   RUSAK ]
```

### 8.6 Scan Screen
Template standar:
- judul aksi;
- target yang dicari;
- area kamera/scan;
- instruksi satu baris;
- fallback `Masukkan Kode`;
- feedback audio/haptic bila perangkat mendukung.

Setelah scan berhasil, lanjut otomatis bila tidak ada ambiguity.

### 8.7 Exception Sheet
Exception bukan form baru yang kompleks.

Contoh:

```text
Barang kurang

Diminta   10
Ada        8

Kenapa?
[Stok Habis]
[Barang Rusak]
[Salah Lokasi]
[Lainnya]

[ LAPORKAN 8 ]
```

### 8.8 Confirmation
Hanya gunakan confirmation dialog untuk:
- tindakan irreversible;
- uang;
- close period;
- cancel/void;
- perubahan hak akses;
- posting journal;
- stock adjustment final.

Jangan konfirmasi setiap klik biasa.

### 8.9 Toast
Toast untuk feedback non-blocking:
- “Tersimpan”
- “Akan dikirim saat internet kembali”

Error yang memerlukan tindakan harus inline atau modal, bukan hilang setelah 3 detik.

---

## 9. State & Feedback

### 9.1 Loading
Jangan gunakan spinner tanpa konteks >2 detik.
Gunakan skeleton untuk page/list dan progress text untuk pekerjaan batch.

### 9.2 Empty state
Harus menjelaskan keadaan:

> **Tidak ada pekerjaan saat ini**  
> Semua picking untuk rute pagi sudah selesai.

### 9.3 Offline state
Status global kecil tetapi selalu terlihat ketika offline:

```text
● Offline · 3 pekerjaan menunggu dikirim
```

Jangan memblokir workflow yang memang offline-capable.

### 9.4 Sync conflict
Bahasa pengguna:

> **Data sudah berubah**  
> Pesanan ini diperbarui oleh Sales Admin pukul 10:42. Muat data terbaru sebelum melanjutkan.  
> `[MUAT ULANG]`

---

## 10. Pola UX per Role

### 10.1 Sales — “Hari Ini” sebagai home
Urutan:
1. Kunjungan berikutnya.
2. Tagihan yang harus ditagih.
3. Pesanan bermasalah.
4. Progress hari ini.

Tidak boleh menampilkan chart kompleks di mobile Sales.

### 10.2 Gudang — Queue-driven
Default screen = pekerjaan berikutnya.

Prinsip wajib dari PRD:

> **SCAN → CONFIRM → NEXT**

Flow picking:
1. Tampilkan lokasi.
2. Scan lokasi.
3. Tampilkan barang/jumlah.
4. Scan barang.
5. Konfirmasi qty.
6. Next otomatis.

Free-text exception tidak menjadi pilihan pertama.

### 10.3 Driver — One-handed
- max 2 tombol primer;
- large type;
- route cached;
- COD amount boleh terlihat;
- harga produk tidak terlihat;
- action utama: `Sudah Sampai`, `Terkirim`, `Gagal Dikirim`.

### 10.4 Admin
Admin beroperasi melalui **work queues**:
- Pesanan perlu dicek.
- Customer belum cocok.
- Data import gagal.
- Invoice belum lengkap.

### 10.5 Finance
Home berorientasi close dan exception:

```text
September 2026
Tutup Buku 72%

12 transaksi bank perlu dicocokkan
3 jurnal menunggu persetujuan
1 selisih persediaan
4 invoice belum cocok
```

Mode awal menyembunyikan debit/credit bila template jurnal tersedia. Role `FINANCE_ACCOUNTANT_ADVANCED` dapat membuka detail debit/credit.

### 10.6 Management / Control Station
Dashboard menjawab:
1. Apa yang terjadi hari ini?
2. Apa yang tidak normal?
3. Apa yang harus ditindaklanjuti?

KPI tidak boleh melebihi 8–10 kartu utama per view.

---

## 11. Finance UX Patterns

### 11.1 Manual Journal Wizard
Tahap:
1. Pilih tujuan jurnal.
2. Isi konteks minimum.
3. Sistem membangun line template.
4. Review debit/credit.
5. Upload bukti.
6. Submit approval.

Kategori awal:
- Akrual Biaya
- Penyusutan
- Biaya Bank
- Pajak
- Koreksi
- Penyesuaian Audit
- Lainnya

### 11.2 Tutup Buku
Gunakan checklist yang menunjukkan owner + status.

```text
Penjualan cutoff             ✓
Invoice completeness         ✓
Rekonsiliasi AR              ✓
Persediaan                   Perlu Dicek
Rekonsiliasi Bank            ✓
Akrual                       ✓
Pajak                        Menunggu
Review Neraca Saldo          Menunggu
```

Primary CTA selalu:
- `Lanjutkan Tutup Buku`, atau
- `Selesaikan 3 Masalah`.

### 11.3 Financial Reports
P&L, Neraca, dan Arus Kas harus menyediakan:
- periode;
- perbandingan periode sebelumnya;
- filter Branch / Principal / Revenue Stream bila relevan;
- drill-down dari angka → GL line → journal → source document.

---

## 12. Tables

Table desktop wajib:
- sticky header bila panjang;
- filter terlihat dan dapat dihapus;
- sorting hanya untuk field relevan;
- kolom angka right-aligned;
- currency tabular;
- pagination/server-side untuk dataset besar;
- row click tidak boleh menjadi satu-satunya cara membuka detail — sediakan action eksplisit.

Jangan membuat 25 kolom terlihat sekaligus. Gunakan column presets berdasarkan role.

---

## 13. Charts & Data Visualization

Gunakan chart hanya untuk menjawab pertanyaan bisnis.

Prioritas:
1. big number + delta;
2. bar;
3. line;
4. stacked bar;
5. table.

Hindari pie/donut dengan banyak kategori.

Gunakan maksimal 5 seri warna dalam satu chart.

Warna chart tidak boleh menyalahi semantic color. Merah tidak digunakan sekadar karena sesuai brand bila tidak bermakna negatif/attention.

---

## 14. Bahasa & Microcopy

### 14.1 Bahasa produk
Semua UI pengguna menggunakan Bahasa Indonesia.

Kode dan kontrak tetap English:

```text
UI: "Piutang Usaha"
Code: accountsReceivable
DB: ar.receivable
```

### 14.2 Gaya bahasa
- pendek;
- aktif;
- langsung;
- tidak menggunakan jargon bila ada kata kerja sederhana;
- jangan menyalahkan pengguna.

Contoh:

Buruk: `Entity mapping validation failed.`  
Baik: `Toko belum dikenali. Pilih toko yang benar.`

Buruk: `Insufficient credit exposure.`  
Baik: `Pesanan perlu persetujuan karena batas kredit terlampaui.`

### 14.3 Istilah baku

| Technical | UI Bahasa Indonesia |
|---|---|
| Sales Order | Pesanan Penjualan |
| Fulfillment | Pemenuhan Pesanan |
| Delivery Order | Surat Jalan / Perintah Pengiriman |
| Accounts Receivable | Piutang Usaha |
| Accounts Payable | Utang Usaha |
| General Ledger | Buku Besar |
| Journal | Jurnal |
| Trial Balance | Neraca Saldo |
| Profit & Loss | Laporan Laba Rugi |
| Balance Sheet | Neraca / Laporan Posisi Keuangan |
| Cash Flow | Laporan Arus Kas |
| Reconciliation | Rekonsiliasi |
| Month-end Close | Tutup Buku Bulanan |
| Exception | Perlu Ditindaklanjuti |
| Credit Hold | Perlu Persetujuan Kredit |
| Unmatched Customer | Toko Belum Dikenali |
| Short Pick | Barang Kurang |

---

## 15. Accessibility

Minimum:
- WCAG 2.2 AA untuk contrast dan keyboard pada web;
- focus ring selalu terlihat;
- tidak mengandalkan warna saja;
- form error terhubung secara programmatic ke field;
- semua icon-only buttons memiliki accessible label;
- screen-reader label untuk scan/foto bila relevan;
- target mobile minimal 48 px;
- zoom browser tidak boleh merusak workflow sampai 200%.

---

## 16. Performance UX Budget

Target UI:
- initial PWA setelah install/cache ≤5 detik pada jaringan 3G;
- screen transition lokal terasa ≤200 ms;
- scan confirmation feedback ≤700 ms target bila online;
- tidak ada blocking full-screen loading untuk background sync;
- gambar dikompresi sebelum upload bila workflow mengizinkan;
- dashboard utama ≤3 detik target.

---

## 17. Design Tokens — Tailwind/CSS

Canonical token names:

```ts
export const colors = {
  brand: {
    navy: '#0A2359',
    navyDark: '#041D54',
    red: '#EA0711',
    cream: '#F6F5F0',
  },
  semantic: {
    success: '#15803D',
    warning: '#A16207',
    danger: '#B91C1C',
    info: '#1D4ED8',
  },
};
```

Tidak boleh menulis hex color arbitrer di component feature. Semua warna harus melalui token.

---

## 18. Page Templates

### Template A — Mobile Task

```text
[Header: konteks pendek]

[Instruksi utama]
[Objek kerja]
[Informasi minimum]

[Kontrol utama]

----------------------
[Primary Action sticky]
```

### Template B — Queue Desktop

```text
[Judul] [Count]
[Filter minimum]

[Tabs: Semua | Perlu Dicek | Terlambat]

[Table/List]

[Side panel detail bila dipilih]
```

### Template C — Control Station

```text
[Periode] [Branch] [Principal]

[KPI ringkas]

[Perlu Ditindaklanjuti]

[Operational funnel]

[Financial/AR summary]
```

### Template D — Finance Close

```text
[Periode + status]
[Progress]

[Checklist per domain]

[Exceptions]

[Review report]

[Close Period]
```

---

## 19. AI/Coding Agent UI Rules

Coding Agent wajib:
1. Mencari komponen di `packages/ui` sebelum membuat komponen baru.
2. Menggunakan token, bukan raw color/spacing.
3. Menggunakan komponen role/workflow yang sudah ada.
4. Tidak menambah field UI hanya karena field tersedia di API.
5. Tidak mengekspos enum/backend state mentah.
6. Semua copy pengguna Bahasa Indonesia.
7. Menambahkan empty/loading/error/offline states.
8. Memenuhi keyboard/accessibility untuk desktop.
9. Memenuhi touch target untuk mobile.
10. Menulis test minimal untuk critical workflow.
11. Menghindari modal bertingkat.
12. Menghindari form lebih dari 7 field terlihat sekaligus; pecah menjadi step atau progressive disclosure.
13. Tidak membuat custom icon set, chart engine, form engine, scanner protocol, atau table engine.

---

## 20. Definition of Done — UI

Satu screen belum selesai bila:
- tidak jelas apa next action-nya;
- state loading/error/empty/offline belum dibuat;
- copy masih memakai jargon teknis;
- ada raw enum yang terlihat;
- mobile touch target terlalu kecil;
- critical workflow belum diuji pada viewport Android kelas menengah;
- permission/role state belum diuji;
- action finansial/destruktif belum memiliki confirmation/audit reason sesuai policy;
- color/token tidak berasal dari design system;
- component duplicate sudah ada di `packages/ui`.

---

## 21. Prinsip Akhir

PSS UI tidak dinilai dari banyaknya fitur yang terlihat.

PSS UI dianggap berhasil bila:

> **Sales tahu toko mana yang harus dikunjungi.**  
> **Picker tahu barang mana yang harus diambil.**  
> **Driver tahu kiriman berikutnya.**  
> **Admin tahu masalah mana yang harus diselesaikan.**  
> **Finance tahu apa yang menghalangi tutup buku.**  
> **Management tahu apa yang terjadi dan apa yang perlu ditindaklanjuti.**

Semua kompleksitas lainnya adalah tanggung jawab sistem.
