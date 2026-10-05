// Data feed. `?feed=hub` (default): WebSocket per docs/data-model.md. `?feed=demo`: built-in synthetic generator.
// Optional `?hub=ws://host:port/ws` overrides the hub URL.
import { CFG } from "./config";
import { DemoFeed } from "./demo";
import { applyMsg, setStatus } from "./store";
import type { ServerMsg } from "./types";

export function feedMode(): "hub" | "demo" {
  return new URLSearchParams(location.search).get("feed") === "demo" ? "demo" : "hub";
}

export function startFeed(): () => void {
  const params = new URLSearchParams(location.search);
  if (feedMode() === "demo") {
    const demo = new DemoFeed(applyMsg);
    setStatus("demo", "synthetic feed");
    demo.start();
    return () => demo.stop();
  }

  const url = params.get("hub") ?? CFG.HUB_URL;
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let timer: number | undefined;

  const connect = () => {
    setStatus("connecting", url);
    ws = new WebSocket(url);
    ws.onopen = () => {
      retry = 0;
      setStatus("live", url);
      ws?.send(JSON.stringify({ v: 1, type: "hello" }));
    };
    ws.onmessage = (m) => {
      try {
        const msg = JSON.parse(String(m.data)) as ServerMsg;
        if (msg && msg.v === 1) applyMsg(msg);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (closed) return;
      setStatus("offline", `retrying ${url}`);
      timer = window.setTimeout(connect, Math.min(5000, 600 * 2 ** retry++));
    };
    ws.onerror = () => ws?.close();
  };
  connect();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
