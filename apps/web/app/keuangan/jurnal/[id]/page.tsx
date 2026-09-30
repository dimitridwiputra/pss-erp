import { JournalDetail } from '../../finance-views';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <JournalDetail id={(await params).id} />;
}
