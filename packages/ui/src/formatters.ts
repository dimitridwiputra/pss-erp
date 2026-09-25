const rupiahFormatter = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0,
});

const dateFormatter = new Intl.DateTimeFormat('id-ID', {
  dateStyle: 'medium',
  timeZone: 'Asia/Jakarta',
});

export function formatRupiah(wholeRupiah: bigint): string {
  return rupiahFormatter.format(wholeRupiah);
}

export function formatJakartaDate(instant: Date): string {
  return dateFormatter.format(instant);
}
