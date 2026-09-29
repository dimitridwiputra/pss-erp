import { LoadingState } from '@pss/ui';

/** UX-003 / DSY §9.1: the route-level skeleton while the server composes the inbox. */
export default function PersetujuanLoading() {
  return (
    <main className="page-shell approval-page" aria-busy="true">
      <LoadingState label="Sedang memuat daftar persetujuan" rows={3} />
    </main>
  );
}
