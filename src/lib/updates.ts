/**
 * Deciding whether to tell the user a new version exists.
 *
 * Pure: the fetch and the storage live in the component. What is worth
 * testing is the comparison and the "should we say anything" rule, and
 * both are easy to get subtly wrong — a string compare puts 0.10.0
 * before 0.9.0, and a dismissal that never expires means a user who
 * says "not now" once is never told again.
 */

/** A version's numeric parts, or null when the text is not a version. */
function parts(version: string): number[] | null {
  // Release tags carry a leading `v`; the app's own version does not.
  const cleaned = version.trim().replace(/^v/i, "");
  // The prerelease suffix is handled by the caller, not here.
  const [core] = cleaned.split("-");
  if (!/^\d+(\.\d+)*$/.test(core)) return null;
  return core.split(".").map(Number);
}

/**
 * Order two versions: negative when `a` is older, positive when newer.
 *
 * A prerelease sorts below the release it leads to, so `0.3.0-beta.1`
 * is older than `0.3.0` — otherwise "update available" could point at a
 * downgrade.
 */
export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  if (!left || !right) return 0;

  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    // A missing part is zero: 1.2 and 1.2.0 are the same version.
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }

  const leftPre = a.includes("-");
  const rightPre = b.includes("-");
  if (leftPre === rightPre) return 0;
  return leftPre ? -1 : 1;
}

export interface NotifyArgs {
  /** The running app's version. */
  current: string;
  /** The tag of the newest published release. */
  latest: string;
  /** The version the user last dismissed, if any. */
  dismissed: string | null;
  /** Whether the user has left update checks on. */
  enabled: boolean;
}

/**
 * Whether to show the update banner.
 *
 * Silent when either version is unreadable: a tag that is not a version
 * says nothing useful, and guessing would mean nagging about a
 * "downgrade" to something like `nightly`.
 */
export function shouldNotify({
  current,
  latest,
  dismissed,
  enabled,
}: NotifyArgs): boolean {
  if (!enabled) return false;
  if (!parts(current) || !parts(latest)) return false;
  if (compareVersions(latest, current) <= 0) return false;
  // Dismissing a version means "not that one" — a later one is a new
  // question.
  if (dismissed && compareVersions(latest, dismissed) <= 0) return false;
  return true;
}
