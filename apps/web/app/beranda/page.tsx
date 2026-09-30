import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { ArrowRight, CheckSquare } from 'lucide-react';
import { EmptyState, ErrorState, PageHeader } from '@pss/ui';
import { getPssServerAccessToken } from '../../auth';
import { resolveHome } from '../../lib/experience/experience-handler';
import { httpUpstreamTransport } from '../../lib/experience/transport';
import { workScreens } from '../../lib/navigation/work-screens';
import { ShellIcon } from '../_shell/icons';
import { HomeConnectivity } from './home-connectivity';
import { HomeWidgets } from './widgets';

export const metadata = { title: 'Beranda | PSS' };

const jakartaHour = () => Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Jakarta' }).format(new Date()));
const jakartaLongDate = () => new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' }).format(new Date());

function greeting(): string {
  const hour = jakartaHour();
  if (hour < 11) return 'Selamat pagi';
  if (hour < 15) return 'Selamat siang';
  if (hour < 19) return 'Selamat sore';
  return 'Selamat malam';
}

export default async function SignedInHome() {
  const accessToken = await getPssServerAccessToken();
  if (!accessToken) redirect('/masuk');

  const outcome = await resolveHome({ transport: httpUpstreamTransport, accessToken, requestId: randomUUID(), instance: '/beranda' });
  if (outcome.kind === 'PROBLEM' && outcome.problem.code === 'UNAUTHENTICATED') redirect('/masuk');
  if (outcome.kind === 'PROBLEM') {
    return <ErrorState problem={outcome.problem} action={<Link className="pss-button pss-button-primary" href="/beranda">Coba lagi</Link>} />;
  }

  const { view } = outcome;
  const screenKeys = view.workTiles.map((tile) => tile.key);
  const iconOf = (key: string) => workScreens.find((screen) => screen.key === key)?.icon ?? 'home';

  return (
    <div className="home-dashboard">
      <PageHeader eyebrow={jakartaLongDate()} title={`${greeting()}, ${view.viewer.displayName}`}
        description="Ringkasan hari ini dan layar kerja yang bisa Anda buka." />
      <HomeConnectivity />

      {view.incomplete && (
        <section className="approval-partial" role="status">
          <h2>Sebagian informasi belum terbaca</h2>
          <p>Daftar akses atau wewenang Anda mungkin belum lengkap. Muat ulang halaman ini sebelum memulai pekerjaan.</p>
          <Link href="/beranda">Muat ulang</Link>
        </section>
      )}

      {view.primaryAction && (
        <section className="home-next-action" aria-label="Tindakan berikutnya">
          <span className="home-next-icon" aria-hidden="true"><CheckSquare size={22} /></span>
          <div>
            <p className="pss-page-eyebrow">Tindakan berikutnya</p>
            <h2>Persetujuan</h2>
            <p>Periksa permintaan yang menjadi wewenang Anda.</p>
          </div>
          <Link className="pss-button pss-button-primary" href={view.primaryAction.href}>{view.primaryAction.label} <ArrowRight size={18} aria-hidden="true" /></Link>
        </section>
      )}

      <HomeWidgets screenKeys={screenKeys} />

      {view.workTiles.length > 0 ? (
        <section className="home-work" aria-labelledby="home-work-title">
          <h2 id="home-work-title">Buka layar kerja</h2>
          <ul>
            {view.workTiles.map((tile) => (
              <li key={tile.key}>
                <Link className="home-work-tile" href={tile.href}>
                  <span className="home-work-icon" aria-hidden="true"><ShellIcon name={iconOf(tile.key)} /></span>
                  <span className="home-work-text"><strong>{tile.label}</strong><span>{tile.description}</span></span>
                  <ArrowRight className="home-work-arrow" size={18} aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : !view.primaryAction && (
        <EmptyState title="Belum ada pekerjaan yang siap dibuka" description="Pekerjaan baru akan muncul di sini ketika alur untuk akun Anda sudah tersedia." />
      )}

      {view.products === null ? (
        <ErrorState problem={{ title: 'Daftar aplikasi belum terbaca', message: 'Muat ulang halaman ini untuk melihat akses aplikasi Anda.' }} action={<Link href="/beranda">Muat ulang</Link>} />
      ) : view.products.length === 0 ? (
        <p className="home-access-note">Belum ada akses aplikasi untuk akun Anda. Hubungi Admin Sistem jika Anda seharusnya memiliki pekerjaan di PSS.</p>
      ) : (
        <section className="home-products" aria-labelledby="home-products-title">
          <h2 id="home-products-title">Akses aplikasi Anda</h2>
          <ul>{view.products.map((product) => <li key={product.key}>{product.label}</li>)}</ul>
        </section>
      )}
    </div>
  );
}
