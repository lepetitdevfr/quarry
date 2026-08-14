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

  return { schema, loading, error, refresh: load };
}
