export type AvatarProps = {
  name: string;
  size?: 'sm' | 'md';
  presence?: 'online' | 'offline';
};

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] ?? '?').concat(parts[1]?.[0] ?? '').toUpperCase();
}

/** Initials avatar with an optional presence dot — no photo upload/storage involved. */
export function Avatar({ name, size = 'md', presence }: AvatarProps) {
  return (
    <span className={`pss-avatar pss-avatar-${size}`}>
      {initialsOf(name)}
      {presence && <span className={`pss-avatar-dot pss-avatar-dot-${presence}`} role="status" aria-label={presence === 'online' ? 'Online' : 'Offline'} />}
    </span>
  );
}
