/** How times and 8-counts are written for her. */

export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

/** 8-count index 0 is shown as "1". Pre-roll before count 1 has no number. */
export function ecLabel(ec: number): string {
  return ec >= 0 ? String(ec + 1) : '–';
}

export function ecRangeLabel(a: number, b: number): string {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  if (hi < 0) return 'Intro (before count 1)';
  if (lo === hi) return `8-count ${ecLabel(lo)}`;
  return `8-counts ${ecLabel(Math.max(0, lo))}–${ecLabel(hi)}`;
}

/** One decimal at most, and none when it would be ".0". */
export function formatBpm(bpm: number): string {
  return String(Math.round(bpm * 10) / 10);
}
