export const FILL_COLORS = [
  '#fde68a',
  '#bfdbfe',
  '#bbf7d0',
  '#fecaca',
  '#ddd6fe',
  '#e2e8f0',
] as const;

const USER_COLORS = [
  '#e11d48',
  '#2563eb',
  '#16a34a',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#4f46e5',
];

/** Stable per-user color so the same person looks the same on every screen. */
export function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length]!;
}
