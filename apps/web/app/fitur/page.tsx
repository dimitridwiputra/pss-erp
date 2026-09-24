import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import catalog from '../../data/features.generated.json';
import { FeatureDirectory, type Feature } from './feature-directory';
import './styles.css';

export const metadata = {
  title: 'Peta Fitur | PSS Operating Platform',
  description: 'Direktori internal fitur PSS berdasarkan PRD dan implementation plan.',
};

export default function FeaturesPage() {
  if (process.env.NODE_ENV !== 'development') notFound();

  return (
    <main className="directory-shell">
      <header className="directory-header">
        <Link href="/" aria-label="Kembali ke beranda PSS">
          <Image src="/pss-logo.png" alt="Putra Sumber Sari" width={210} height={70} priority />
        </Link>
        <div className="directory-header-actions">
          <span className="directory-env">Lingkungan pengembangan</span>
          <Link href="/">Beranda <span aria-hidden="true">↗</span></Link>
        </div>
      </header>

      <section className="directory-hero" aria-labelledby="directory-title">
        <div className="directory-intro">
          <p className="directory-eyebrow">PETA PRODUK / SUMBER PRD</p>
          <h1 id="directory-title">Lihat seluruh fitur PSS.</h1>
          <p>Jelajahi rencana ERP dari fondasi platform hingga pekerjaan Sales, Gudang, Antar, Admin, Keuangan, dan Control Station. Status di bawah menunjukkan implementasi saat ini, bukan janji bahwa alur transaksi sudah dapat dipakai.</p>
          <div className="directory-pilot"><span aria-hidden="true">●</span> Pilot operasi: Cimahi</div>
        </div>
        <div className="directory-source-card">
          <span>SUMBER & STATUS</span>
          <strong>280 fitur</strong>
          <p>Nama, tujuan, fase, dan sprint mengikuti PRD serta implementation plan. Hanya fitur yang sudah diverifikasi diberi status tersedia atau sebagian.</p>
        </div>
      </section>

      <FeatureDirectory features={catalog as Feature[]} />

      <footer className="directory-footer">
        <span>Putra Sumber Sari · Peta pengembangan internal</span>
        <Link href="/">Kembali ke beranda</Link>
      </footer>
    </main>
  );
}
