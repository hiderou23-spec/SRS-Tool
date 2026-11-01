export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const nowIso = () => new Date().toISOString();

/** Local "study day" key. A day starts at `dayStartHour` (default 4am) like Anki. */
export function dayKey(date: Date = new Date(), dayStartHour = 4): string {
  const d = new Date(date.getTime() - dayStartHour * 3600_000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** End of the current study day (next day boundary). */
export function endOfStudyDay(date: Date = new Date(), dayStartHour = 4): Date {
  const shifted = new Date(date.getTime() - dayStartHour * 3600_000);
  const end = new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate() + 1, dayStartHour, 0, 0, 0);
  return end;
}

/** FNV-1a 32-bit hash, hex. Stable and fast; used for idempotency keys, not security. */
export function hash(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Longer hash: two FNV passes with different seeds → 64 bits of hex. */
export function hash64(str: string): string {
  return hash(str) + hash('\u0001' + str + str.length);
}

export function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin}分`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h}時間${m}分` : `${h}時間`;
}

export function formatInterval(days: number): string {
  if (days < 1 / 24) return `${Math.max(1, Math.round(days * 24 * 60))}分`;
  if (days < 1) return `${Math.round(days * 24)}時間`;
  if (days < 30) return `${Math.round(days)}日`;
  if (days < 365) return `${(days / 30).toFixed(days < 90 ? 1 : 0)}ヶ月`;
  return `${(days / 365).toFixed(1)}年`;
}

export function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}
