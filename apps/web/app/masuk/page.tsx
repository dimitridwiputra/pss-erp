import Image from 'next/image';
import { getPssSession, signIn } from '../../auth';
import { redirect } from 'next/navigation';

export const metadata = { title: 'Masuk ke PSS' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await getPssSession();
  const { error } = await searchParams;
  if (session?.pssAccount && !session.error) redirect('/beranda');

  return (
    <main className="page-shell auth-page">
      <header className="masthead">
        <Image src="/pss-logo.png" alt="Putra Sumber Sari" width={274} height={91} priority />
        <span className="phase-tag">Akses internal PSS</span>
      </header>
      <section className="auth-card" aria-labelledby="signin-title">
        <p className="eyebrow">AKUN PSS</p>
        <h1 id="signin-title">Masuk ke PSS</h1>
        <p>Gunakan akun kerja Anda untuk membuka pekerjaan yang menjadi wewenang Anda.</p>
        {(session?.error || error) && <p role="alert" className="auth-error">
          {error === 'AccessDenied'
            ? 'Akun PSS Anda belum aktif atau belum diberi akses. Hubungi Admin Sistem.'
            : error === 'ServiceUnavailable'
              ? 'Layanan akun sedang bermasalah. Coba lagi beberapa saat.'
            : 'Sesi Anda berakhir atau layanan masuk sedang bermasalah. Coba masuk lagi.'}
        </p>}
        <form action={async () => {
          'use server';
          await signIn('keycloak', { redirectTo: '/beranda' });
        }}>
          <button className="home-primary-link" type="submit">Masuk dengan akun PSS <span aria-hidden="true">→</span></button>
        </form>
      </section>
      <footer>Putra Sumber Sari · Akses internal</footer>
    </main>
  );
}
