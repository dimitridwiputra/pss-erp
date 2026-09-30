import {
  ArrowLeftRight, Barcode, BookOpen, Boxes, CalendarCheck, CheckSquare, FileBarChart, FileText, Home, Landmark,
  LayoutDashboard, PackageCheck, PackagePlus, PenLine, Receipt, Scale, ShoppingCart, TriangleAlert, Users, Wallet,
  type LucideIcon,
} from 'lucide-react';

/**
 * Icon names a work screen may use (lib/navigation/work-screens.ts). Names, not components, so the
 * navigation can be computed on the server and passed to the client shell. Append-only.
 */
export const shellIcons: Readonly<Record<string, LucideIcon>> = {
  home: Home,
  persetujuan: CheckSquare,
  kasir: ShoppingCart,
  'serah-barang': PackageCheck,
  penjualan: Receipt,
  'setoran-kas': Wallet,
  dasbor: LayoutDashboard,
  barang: Barcode,
  harga: PenLine,
  pelanggan: Users,
  stok: Boxes,
  terima: PackagePlus,
  penyesuaian: ArrowLeftRight,
  jurnal: BookOpen,
  'buku-besar': FileText,
  'neraca-saldo': Scale,
  laporan: FileBarChart,
  neraca: Landmark,
  pengecualian: TriangleAlert,
  periode: CalendarCheck,
};

export function ShellIcon({ name }: { name: string }) {
  const Icon = shellIcons[name] ?? FileText;
  return <Icon size={20} strokeWidth={1.9} />;
}
