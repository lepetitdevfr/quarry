interface Props {
  version: string;
  /** The release page for this version. */
  url: string;
  onDismiss: () => void;
  onDisable: () => void;
}

/**
 * A quiet notice that a newer version exists.
 *
 * It links rather than installs: builds are unsigned and there is no
 * updater, so the honest offer is "here is where it lives", not a button
 * that implies the app can replace itself.
 */
export function UpdateBanner({ version, url, onDismiss, onDisable }: Props) {
  return (
    <div className="update-banner">
      <span className="update-text">
        Quarry {version} is available.{" "}
        <a href={url} target="_blank" rel="noopener noreferrer">
          See what changed ↗
        </a>
      </span>
      <button className="secondary" onClick={onDismiss}>
        Not now
      </button>
      {/* Turning the check off entirely is one click, not buried in a
          settings screen: an app that phones home should be easy to
          stop. */}
      <button className="secondary" onClick={onDisable}>
        Stop checking
      </button>
    </div>
  );
}
