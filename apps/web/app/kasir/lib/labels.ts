/** UX-04: work-language labels for counter states; a raw status never reaches the screen. */
export const saleStatusLabel: Record<string, { label: string; tone: 'green' | 'blue' | 'yellow' | 'red' }> = {
  CART: { label: 'Masih di keranjang', tone: 'blue' },
  PENDING_PAYMENT: { label: 'Menunggu pembayaran', tone: 'yellow' },
  PAID: { label: 'Lunas · barang belum diambil', tone: 'blue' },
  CREDIT_APPROVED: { label: 'Tempo disetujui', tone: 'blue' },
  HANDED_OVER: { label: 'Selesai', tone: 'green' },
  CANCELLED: { label: 'Dibatalkan', tone: 'red' },
};

export const handoverStatusLabel: Record<string, { label: string; tone: 'green' | 'blue' | 'yellow' | 'red' }> = {
  DECLARED: { label: 'Menunggu dihitung', tone: 'yellow' },
  VERIFIED: { label: 'Sudah diterima', tone: 'green' },
  DISCREPANCY: { label: 'Perlu keputusan selisih', tone: 'red' },
  RESOLVED: { label: 'Selisih diputuskan', tone: 'green' },
};

/** Registered Appendix F reason codes of area CSH (MVP-OD-9); the verifier sees only the words. */
export const cashVarianceReasons = [
  { code: 'RC-CSH-COUNT_SHORT', label: 'Uang kurang' },
  { code: 'RC-CSH-COUNT_OVER', label: 'Uang lebih' },
  { code: 'RC-CSH-LOST', label: 'Uang hilang' },
  { code: 'RC-CSH-WRONG_EVIDENCE', label: 'Bukti tidak sesuai' },
] as const;

export function reasonLabel(code: string | null): string | null {
  return code ? cashVarianceReasons.find((reason) => reason.code === code)?.label ?? 'Alasan lain' : null;
}

const dateTime = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' });
export function jakartaDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

export function jakartaToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
