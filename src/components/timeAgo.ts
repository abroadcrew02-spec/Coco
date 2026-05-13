// Minimal Japanese "ago" formatter. Live-updating ticker is intentionally
// avoided — callers can re-render or compute on hover when needed.
export function timeAgoJa(when: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - when) / 1000));
  if (seconds < 5) return "たった今";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 時間前`;
  const days = Math.round(hours / 24);
  return `${days} 日前`;
}
