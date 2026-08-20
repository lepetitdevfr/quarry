import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "../lib/ipc";
import type { Connection, ConnectionInfo, ConnectionInput } from "../types";

/**
 * Owns the saved-connection list and which one is live.
 *
 * The app never connects on its own: `active` starts null on every
 * launch and only a deliberate `connect` call fills it.
 */
export function useConnections() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [active, setActive] = useState<ConnectionInfo | null>(null);
  // Which connection is being dialled, not merely that one is: the
  // picker names it while it waits.
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Bumped by every attempt and by every cancel, so a reply can tell
  // whether anyone is still waiting for it.
  const attempt = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await ipc.listConnections();
      if (cancelled) return;
      setConnections(list);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Dial a saved connection.
   *
   * Returns `null` when the attempt was cancelled or superseded, which
   * is not a failure and must not be reported as one. A cancelled
   * attempt that lands anyway is disconnected immediately: the backend
   * installed a live connection nobody asked for any more, and leaving
   * it there would make the app connected to a database it says it is
   * not connected to.
   */
  const connect = useCallback(async (id: string, password?: string) => {
    const token = ++attempt.current;
    setConnectingId(id);
    try {
      const info = await ipc.connectSaved(id, password);
      if (token !== attempt.current) {
        await ipc.disconnect();
        return null;
      }
      setActive(info);
      setConnections(await ipc.listConnections());
      return info;
    } finally {
      setConnectingId((current) =>
        token === attempt.current ? null : current,
      );
    }
  }, []);

  /**
   * Stop waiting. The request itself cannot be recalled — it is a
   * round trip already in flight — so this abandons its reply and lets
   * the backend's own deadline end it.
   */
  const cancelConnect = useCallback(() => {
    attempt.current += 1;
    setConnectingId(null);
  }, []);

  const disconnect = useCallback(async () => {
    await ipc.disconnect();
    setActive(null);
  }, []);

  const actions = {
    connect,
    cancelConnect,
    disconnect,
    create: async (input: ConnectionInput) =>
      setConnections(await ipc.createConnection(input)),
    update: async (id: string, input: ConnectionInput) =>
      setConnections(await ipc.updateConnection(id, input)),
    remove: async (id: string) => {
      setConnections(await ipc.deleteConnection(id));
      // Deleting the live connection disconnects it backend-side.
      setActive(await ipc.activeConnection());
    },
  };

  return { connections, active, connectingId, loaded, actions };
}
