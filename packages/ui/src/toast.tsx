export type ToastProps = {
  message: string;
  tone?: 'info' | 'success' | 'warning' | 'danger';
  state?: 'default' | 'loading' | 'disabled' | 'error';
};

export function Toast({ message, tone = 'info', state = 'default' }: ToastProps) {
  const role = tone === 'danger' || state === 'error' ? 'alert' : 'status';
  return <div className={`pss-toast pss-toast-${tone} pss-toast-state-${state}`} role={role}>{state === 'loading' ? 'Sedang menyimpan…' : message}</div>;
}
