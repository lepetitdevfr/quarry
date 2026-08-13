import { useState } from "react";
import { asAppError, connect } from "../lib/ipc";
import type { ConnectionInfo } from "../types";

interface Props {
  onConnected: (info: ConnectionInfo) => void;
}

export function ConnectionForm({ onConnected }: Props) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // One connection in Stage 1; Stage 2 introduces saved connections
      // with real ids.
      const info = await connect("default", url, true);
      onConnected(info);
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="connection-form" onSubmit={handleConnect}>
      <label htmlFor="url">Connection URL</label>
      <input
        id="url"
        type="text"
        placeholder="postgres://user:password@localhost:5432/dbname"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        autoFocus
        spellCheck={false}
      />
      <button type="submit" disabled={busy || url.trim() === ""}>
        {busy ? "Connecting…" : "Connect"}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
