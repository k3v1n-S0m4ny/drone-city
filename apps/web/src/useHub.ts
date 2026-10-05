import { useEffect, useState } from "react";
import { applyServerMsg, parseServerMsg } from "@drone-city/model";
import type { SessionMap } from "@drone-city/model";

export type Connection = "connecting" | "open" | "closed";

/** Connects to the hub's /ws, keeps a local session map, and reconnects with a short backoff. */
export function useHub(): { sessions: SessionMap; connection: Connection } {
  const [sessions, setSessions] = useState<SessionMap>({});
  const [connection, setConnection] = useState<Connection>("connecting");

  useEffect(() => {
    let ws: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let delay = 500;

    const open = (): void => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        delay = 500;
        setConnection("open");
        ws?.send(JSON.stringify({ v: 1, type: "hello" }));
      };
      ws.onmessage = (ev: MessageEvent<string>) => {
        const msg = parseServerMsg(ev.data);
        if (msg) setSessions((prev) => applyServerMsg(prev, msg));
      };
      ws.onclose = () => {
        setConnection("closed");
        if (stopped) return;
        // A fresh snapshot arrives on reconnect and replaces everything.
        timer = setTimeout(open, delay);
        delay = Math.min(delay * 2, 5000);
      };
    };
    open();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return { sessions, connection };
}
