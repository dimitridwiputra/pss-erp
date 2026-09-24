import Image from 'next/image';
import Link from 'next/link';

export default function Home() {
  return (
    <main className="page-shell">
      <header className="masthead">
        <Image src="/pss-logo.png" alt="Putra Sumber Sari" width={274} height={91} priority />
        <span className="phase-tag">Fondasi platform · PLT-001</span>
      </header>
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">PSS OPERATING PLATFORM</p>
        <h1 id="page-title">Satu fondasi untuk operasi distribusi PSS.</h1>
        <p className="lead">Kerangka aplikasi sedang dibangun sesuai PRD. Alur penjualan, gudang, pengiriman, dan keuangan akan diaktifkan setelah kontrol data dan akses siap.</p>
        {process.env.NODE_ENV === 'development' && <Link className="home-primary-link" href="/fitur">Jelajahi 280 fitur <span aria-hidden="true">→</span></Link>}
      </section>
      <section className="status-panel" aria-labelledby="status-title">
        <div>
          <p className="section-label">STATUS PENGEMBANGAN</p>
          <h2 id="status-title">Kerangka awal tersedia</h2>
          <p>Halaman ini menunjukkan lingkungan pengembangan sudah berjalan. Belum ada transaksi atau data operasional yang dapat diproses.</p>
        </div>
        <div className="status-marker"><span aria-hidden="true" className="status-dot" /> Tahap fondasi</div>
      </section>
      <footer>Putra Sumber Sari · Internal development environment</footer>
    </main>
  );
}
