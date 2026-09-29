import Image from 'next/image';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getPssSession, signOut } from '../../auth';

export const metadata = { title: 'Beranda | PSS' };

export default async function SignedInHome() {
  const session = await getPssSession();
  if (!session || session.error || !session.pssAccount) redirect('/masuk');

  const canOpenAdmin = session.grants?.some((grant) => grant.permission === 'orders.order.create') ?? false;
  const canApprove = session.grants?.some((grant) => grant.permission.endsWith('.approve')) ?? false;

  return (
    <main className="page-shell">
      <header className="masthead">
        <Image src="/pss-logo.png" alt="Putra Sumber Sari" width={274} height={91} priority />
        <form action={async () => {
          'use server';
          await signOut({ redirectTo: '/masuk' });
        }}>
          <button className="auth-signout" type="submit">Keluar</button>
        </form>
      </header>
      <section className="hero" aria-labelledby="home-title">
        <p className="eyebrow">HARI INI</p>
        <h1 id="home-title">Selamat datang, {session.pssAccount.displayName}.</h1>
        <p className="lead">Pilih pekerjaan yang tersedia untuk akun Anda.</p>
      </section>
      {canOpenAdmin ? (
        <section className="status-panel" aria-label="Aplikasi yang tersedia">
          <div>
            <p className="section-label">AKSES ANDA</p>
            <h2>PSS Admin</h2>
            <p>Pengaturan akses sudah terhubung. Alur pesanan dan pekerjaan admin akan tampil di sini saat modul operasional siap.</p>
          </div>
          <span className="status-marker">Akses tersedia</span>
        </section>
      ) : (
        <section className="status-panel" aria-label="Belum ada pekerjaan">
          <div>
            <p className="section-label">BELUM ADA PEKERJAAN</p>
            <h2>Akses produk belum ditetapkan</h2>
            <p>Hubungi Admin Sistem jika Anda seharusnya memiliki pekerjaan di PSS.</p>
          </div>
        </section>
      )}
      {canApprove && (
        <section className="status-panel" aria-label="Persetujuan">
          <div><p className="section-label">PERLU KEPUTUSAN</p><h2>Persetujuan</h2><p>Lihat permintaan dari seluruh produk yang menjadi wewenang Anda.</p>
            <Link className="home-primary-link" href="/persetujuan">Buka persetujuan <span aria-hidden="true">→</span></Link>
          </div>
        </section>
      )}
      <footer>Putra Sumber Sari · Beranda internal</footer>
    </main>
  );
}
