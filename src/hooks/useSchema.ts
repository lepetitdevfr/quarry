import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { asAppError, refreshSchema } from "../lib/ipc";
import type { Schema } from "../types";

/**
 * Loads the database structure for the live connection.
 *
 * Keyed on `connectionId`: passing null (disconnected) clears the
 * schema, so autocomplete can never offer tables from a database the
 * user has left.
 */
export function useSchema(connectionId: string | null) {
  const [schema, setSchema] = useState<Schema | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSchema(await refreshSchema());
    } catch (e) {
      // Introspection failing is not fatal: a user without catalog
      // permissions can still run queries. Keep whatever we had.
      setError(asAppError(e).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (connectionId === null) {
      setSchema(null);
      setError(null);
      return;
    }
    void load();
  }, [connectionId, load]);

  // DDL that committed. Without this the tree keeps listing a table
  // you dropped and autocomplete keeps offering the column you renamed
  // until somebody thinks to press the refresh button — and the whole
  // point of autocomplete is not having to think about the schema.
  //
  // The backend decides what counts: it emits this only for a DDL
  // statement that committed, from the same parse the write guard uses,
  // so nothing here has to read SQL to guess.
  useEffect(() => {
    if (connectionId === null) return;
    const subscription = listen("schema://changed", () => void load());
    return () => {
      void subscription.then((unlisten) => unlisten());
    };
  }, [connectionId, load]);

  return { schema, loading, error, refresh: load };
}
