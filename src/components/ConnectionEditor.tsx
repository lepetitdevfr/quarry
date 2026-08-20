import { useState } from "react";
import { colourForTag, parseConnectionUrl } from "../lib/connections";
import { asAppError } from "../lib/errors";
import { testConnection } from "../lib/ipc";
import type { Connection, ConnectionInput, SslMode, Tag } from "../types";

interface Props {
  /** Absent when creating. */
  existing?: Connection;
  onSave: (input: ConnectionInput) => void;
  onCancel: () => void;
}

const TAGS: Tag[] = ["local", "staging", "prod"];
const SSL_MODES: SslMode[] = ["disable", "prefer", "require", "verify-full"];

// `require` genuinely surprises people: it encrypts but does not check
// the certificate. Spell that out rather than let the mode name alone
// imply a guarantee it doesn't make.
const SSL_MODE_LABELS: Record<SslMode, string> = {
  disable: "disable — no encryption",
  prefer: "prefer — encrypt if possible",
  require: "require — encrypt, no certificate check",
  "verify-full": "verify-full — encrypt and verify certificate",
};

export function ConnectionEditor({ existing, onSave, onCancel }: Props) {
  const [name, setName] = useState(existing?.name ?? "");
  const [host, setHost] = useState(existing?.host ?? "localhost");
  const [port, setPort] = useState(String(existing?.port ?? 5432));
  const [user, setUser] = useState(existing?.user ?? "postgres");
  const [dbname, setDbname] = useState(existing?.dbname ?? "postgres");
  const [sslmode, setSslmode] = useState<SslMode>(existing?.sslmode ?? "prefer");
  const [tag, setTag] = useState<Tag>(existing?.tag ?? "local");
  const [password, setPassword] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  // What the last test said, if one has been run. Saving used to be
  // blind: wrong credentials were discovered by saving, clicking the
  // row, and reading a failure about a connection you had already
  // committed to disk.
  const [test, setTest] = useState<
    { state: "testing" } | { state: "ok"; version: string } | { state: "failed"; message: string } | null
  >(null);

  function applyUrl(raw: string) {
    if (raw.trim() === "") return;
    const parsed = parseConnectionUrl(raw);
    if (!parsed) {
      setUrlError("Not a postgres:// URL");
      return;
    }
    setUrlError(null);
    setHost(parsed.host);
    setPort(String(parsed.port));
    setUser(parsed.user);
    setDbname(parsed.dbname);
    setSslmode(parsed.sslmode);
    if (parsed.password) setPassword(parsed.password);
    if (name.trim() === "") setName(parsed.dbname);
  }

  /** The form as the backend wants it. Shared so a test dials exactly
      what a save would store. */
  function asInput(): ConnectionInput {
    return {
      name: name.trim(),
      host: host.trim(),
      port: Number(port) || 5432,
      user: user.trim(),
      dbname: dbname.trim(),
      sslmode,
      tag,
      colour: colourForTag(tag),
      // Empty means "leave the stored password alone" when editing.
      password: password === "" ? null : password,
    };
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    onSave(asInput());
  }

  async function runTest() {
    setTest({ state: "testing" });
    try {
      // The id goes along only when the password field is blank on an
      // existing connection, which is where "keep the stored one" lives.
      const version = await testConnection(asInput(), existing?.id);
      setTest({ state: "ok", version });
    } catch (e) {
      setTest({ state: "failed", message: asAppError(e).message });
    }
  }

  return (
    <form
      className="connection-editor"
      onSubmit={submit}
      onKeyDown={(e) => {
        // Escape cancels, as it does in every other dialog here. This
        // form was the one surface where it did nothing.
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <h2>{existing ? "Edit connection" : "New connection"}</h2>

      <div className="field">
        <label htmlFor="url">Paste a connection URL</label>
        <input
          id="url"
          type="text"
          placeholder="postgres://user:password@host:5432/db"
          spellCheck={false}
          onChange={(e) => applyUrl(e.target.value)}
        />
        <p className="hint">Fills in everything below.</p>
        {urlError && <p className="error">{urlError}</p>}
      </div>

      <div className="field-group">
        <div className="group-title overline">Connection</div>

        <div className="field">
          <label htmlFor="name">Name</label>
          <input id="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>

        <div className="field field-row">
          <div className="grow">
            <label htmlFor="host">Host</label>
            <input id="host" value={host} onChange={(e) => setHost(e.target.value)} />
          </div>
          <div className="narrow">
            <label htmlFor="port">Port</label>
            <input id="port" value={port} onChange={(e) => setPort(e.target.value)} />
          </div>
        </div>

        <div className="field field-row">
          <div className="grow">
            <label htmlFor="user">User</label>
            <input id="user" value={user} onChange={(e) => setUser(e.target.value)} />
          </div>
          <div className="grow">
            <label htmlFor="dbname">Database</label>
            <input id="dbname" value={dbname} onChange={(e) => setDbname(e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label htmlFor="password">
            Password{" "}
            {existing && <span className="hint-inline">(blank keeps the saved one)</span>}
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      </div>

      <div className="field-group">
        <div className="group-title overline">Environment</div>

        <div className="field field-row">
          <div className="grow">
            <label htmlFor="tag">Tag</label>
            <select id="tag" value={tag} onChange={(e) => setTag(e.target.value as Tag)}>
              {TAGS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="grow">
            <label htmlFor="sslmode">SSL mode</label>
            <select
              id="sslmode"
              value={sslmode}
              onChange={(e) => setSslmode(e.target.value as SslMode)}
            >
              {SSL_MODES.map((m) => (
                <option key={m} value={m}>
                  {SSL_MODE_LABELS[m]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* The result sits above the buttons, next to the fields it is
          about — and it is a statement of fact, not a gate: a failing
          test never blocks Save, because a database that is down right
          now is not a reason to lose what you typed. */}
      {test && (
        <p
          className={
            test.state === "failed" ? "test-result failed" : "test-result"
          }
          role="status"
        >
          {test.state === "testing" && "Connecting…"}
          {test.state === "ok" && `Connected — ${test.version}`}
          {test.state === "failed" && test.message}
        </p>
      )}

      <div className="editor-actions">
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => void runTest()}
          disabled={test?.state === "testing"}
        >
          Test connection
        </button>
        <button type="submit" disabled={name.trim() === ""}>
          Save
        </button>
      </div>
    </form>
  );
}
