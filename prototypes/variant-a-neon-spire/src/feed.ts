// Data feed. `?feed=hub` (default) = WebSocket per docs/data-model.md.
// `?feed=demo` = synthetic generator (src/demo.ts). Both write into the store.
import { HUB_URL } from "./config";
import { startDemo } from "./demo";
import { useStore } from "./store";
import type { ServerMsg } from "./types";

export function feedMode(): "hub" | "demo" {
  return new URLSearchParams(location.search).get("feed") === "demo" ? "demo" : "hub";
}

function startHub(): () => void {
  const st = () => useStore.getState();
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry = 0;
  let haveSnapshot = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const url = new URLSearchParams(location.search).get("hub") ?? HUB_URL;

  const connect = () => {
    if (stopped) return;
    st().setConn("connecting", url);
    haveSnapshot = false;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleRetry();
      return;
    }
    ws.onopen = () => {
      retry = 0;
      st().setConn("open", url);
      try {
        ws?.send(JSON.stringify({ v: 1, type: "hello" }));
      } catch {
        /* optional */
      }
    };
    ws.onmessage = (m) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (!msg || msg.v !== 1) return;
      switch (msg.type) {
        case "snapshot":
          haveSnapshot = true;
          st().snapshot(msg.sessions);
          break;
        case "events":
          if (haveSnapshot) st().applyEvents(msg.events);
          break;
        case "session":
          if (haveSnapshot) st().upsert(msg.session);
          break;
        case "remove":
          if (haveSnapshot) st().remove(msg.sessionId);
          break;
      }
    };
    ws.onclose = () => scheduleRetry();
    ws.onerror = () => ws?.close();
  };

  const scheduleRetry = () => {
    if (stopped) return;
    st().setConn("offline", url);
    const delay = Math.min(5000, 600 * 2 ** Math.min(retry++, 4));
    timer = setTimeout(connect, delay);
  };

  connect();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}

export function startFeed(): () => void {
  return feedMode() === "demo" ? startDemo() : startHub();
}
