import { LoadingState } from '@pss/ui';

export default function HomeLoading() {
  return <main className="page-shell" aria-busy="true"><LoadingState label="Sedang memuat pekerjaan Anda" rows={3} /></main>;
}
