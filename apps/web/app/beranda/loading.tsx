import { LoadingState } from '@pss/ui';

export default function HomeLoading() {
  return <div aria-busy="true"><LoadingState label="Sedang memuat pekerjaan Anda" rows={4} /></div>;
}
