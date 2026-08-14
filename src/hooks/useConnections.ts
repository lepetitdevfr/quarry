import { useCallback, useEffect, useState } from "react";
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
  const [connecting, setConnecting] = useState(false);
  const [loaded, setLoaded] = useState(false);

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

  const connect = useCallback(async (id: string, password?: string) => {
    setConnecting(true);
    try {
      const info = await ipc.connectSaved(id, password);
      setActive(info);
      // Connecting changes last_used_at, which changes the order.
      setConnections(await ipc.listConnections());
      return info;
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    await ipc.disconnect();
    setActive(null);
  }, []);

  const actions = {
    connect,
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

  return { connections, active, connecting, loaded, actions };
}
