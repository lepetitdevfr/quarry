/**
 * Seconds as `m:ss` for the unlock banner.
 *
 * Clamped at zero: the banner counts down locally between polls, so it
 * can tick past the real deadline. The server re-checks on every
 * statement regardless, so a display that reached zero is never the
 * thing keeping a connection safe.
 */
export function formatCountdown(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(clamped / 60);
  const rest = clamped % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
