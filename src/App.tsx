import { useCallback, useState } from "react";
import { ConnectionForm } from "./components/ConnectionForm";
import { ResultGrid } from "./components/ResultGrid";
import { SqlEditor } from "./components/SqlEditor";
import { StatusBar } from "./components/StatusBar";
import { asAppError, execute } from "./lib/ipc";
import type { AppErrorPayload, ConnectionInfo, QueryResult } from "./types";
import "./App.css";

export default function App() {
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [sql, setSql] = useState("select 1;");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<AppErrorPayload | null>(null);
  const [busy, setBusy] = useState(false);

  // useCallback keeps this stable so SqlEditor's keymap is not rebuilt
  // on every render.
  const run = useCallback(async () => {
    if (!connection) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await execute(connection.id, sql));
    } catch (e) {
      setError(asAppError(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [connection, sql]);

  if (!connection) {
    return (
      <main className="app centered">
        <h1>Quarry</h1>
        <ConnectionForm onConnected={setConnection} />
      </main>
    );
  }

  return (
    <main className="app">
      <header className="top-bar">
        <strong>
          {connection.user}@{connection.host}:{connection.port}/
          {connection.dbname}
        </strong>
      </header>
      <SqlEditor value={sql} onChange={setSql} onRun={run} busy={busy} />
      {result && <ResultGrid result={result} />}
      <StatusBar result={result} error={error} />
    </main>
  );
}
