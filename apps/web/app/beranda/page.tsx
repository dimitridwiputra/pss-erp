import Image from 'next/image';
import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { EmptyState, ErrorState } from '@pss/ui';
import { getPssServerAccessToken, signOut } from '../../auth';
import { resolveHome } from '../../lib/experience/experience-handler';
import { httpUpstreamTransport } from '../../lib/experience/transport';
import { HomeConnectivity } from './home-connectivity';

export const metadata = { title: 'Beranda | PSS' };

export default async function SignedInHome() {
  const accessToken = await getPssServerAccessToken();
  if (!accessToken) redirect('/masuk');

  const outcome = await resolveHome({
    transport: httpUpstreamTransport,
    accessToken,
    requestId: randomUUID(),
    instance: '/beranda',
  });
  if (outcome.kind === 'PROBLEM' && outcome.problem.code === 'UNAUTHENTICATED') redirect('/masuk');

  return (
    <main className="page-shell home-page">
      <header className="masthead">
        <Image src="/pss-logo.png" alt="Putra Sumber Sari" width={220} height={73} priority />
        <form action={async () => {
          'use server';
          await signOut({ redirectTo: '/masuk' });
        }}>
          <button className="auth-signout" type="submit">Keluar</button>
        </form>
      </header>
      {outcome.kind === 'PROBLEM' ? (
        <ErrorState problem={outcome.problem} action={<Link className="home-primary-link" href="/beranda">Coba lagi</Link>} />
      ) : (
        <>
          <section className="hero" aria-labelledby="home-title">
            <p className="eyebrow">HARI INI</p>
            <h1 id="home-title">Pekerjaan Anda</h1>
            <p className="lead">Selamat datang, {outcome.view.viewer.displayName}.</p>
            <HomeConnectivity />
          </section>
          {outcome.view.incomplete && (
            <section className="approval-partial" role="status">
              <h2>Sebagian informasi belum terbaca</h2>
              <p>Daftar akses atau wewenang Anda mungkin belum lengkap. Muat ulang halaman ini sebelum memulai pekerjaan.</p>
              <Link href="/beranda">Muat ulang</Link>
            </section>
          )}
          {outcome.view.primaryAction ? (
            <section className="status-panel" aria-label="Tindakan berikutnya">
              <div>
                <p className="section-label">TINDAKAN BERIKUTNYA</p>
                <h2>Persetujuan</h2>
                <p>Periksa permintaan yang menjadi wewenang Anda.</p>
                <Link className="home-primary-link" href={outcome.view.primaryAction.href}>{outcome.view.primaryAction.label}</Link>
              </div>
            </section>
          ) : (
            <EmptyState title="Belum ada pekerjaan yang siap dibuka" description="Pekerjaan baru akan muncul di sini ketika alur untuk akun Anda sudah tersedia." />
          )}
          {outcome.view.products === null ? (
            <ErrorState
              problem={{ title: 'Daftar aplikasi belum terbaca', message: 'Muat ulang halaman ini untuk melihat akses aplikasi Anda.' }}
              action={<Link href="/beranda">Muat ulang</Link>}
            />
          ) : outcome.view.products.length === 0 ? (
            <p className="home-access-note">Belum ada akses aplikasi untuk akun Anda. Hubungi Admin Sistem jika Anda seharusnya memiliki pekerjaan di PSS.</p>
          ) : (
            <section className="home-products" aria-labelledby="home-products-title">
              <h2 id="home-products-title">Akses aplikasi Anda</h2>
              <p>Daftar ini menunjukkan hak akses yang tercatat. Alur yang belum siap akan muncul saat tahap rilisnya selesai.</p>
              <ul>{outcome.view.products.map((product) => <li key={product.key}>{product.label}</li>)}</ul>
            </section>
          )}
        </>
      )}
      <footer>Putra Sumber Sari · Beranda internal</footer>
    </main>
  );
}
