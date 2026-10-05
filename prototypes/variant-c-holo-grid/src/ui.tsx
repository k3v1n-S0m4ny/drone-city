import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { CFG, machineColor } from "./config";
import { useCity } from "./store";
import { globalArrivals, rateOf } from "./runtime";
import { LEGEND_ORDER, SYM, symbolFor } from "./symbols";
import { scroll } from "./Scene";
import type { Session, SessionEvent } from "./types";

const fmt = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 3600)}h`;
};
const clock = (ts: number) => new Date(ts).toTimeString().slice(0, 8);

export function Hud() {
  const { status, mode, active, idle, ended, laptop, vps, subs } = useCity(
    useShallow((s) => {
      const all = Object.values(s.sessions);
      return {
        status: s.feedStatus,
        mode: s.feedMode,
        active: all.filter((x) => x.state === "active").length,
        idle: all.filter((x) => x.state === "idle").length,
        ended: all.filter((x) => x.state === "ended").length,
        laptop: all.filter((x) => x.machine === "laptop").length,
        vps: all.filter((x) => x.machine === "vps").length,
        subs: all.reduce((a, x) => a + Object.values(x.subagents).filter((y) => y.state === "running").length, 0),
      };
    }),
  );
  const counts = { active, idle, ended, laptop, vps, subs };
  const [rate, setRate] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setRate(Math.round(rateOf(globalArrivals, performance.now(), 1000))), 250);
    return () => clearInterval(iv);
  }, []);
  const statusColor = status === "live" ? "#7dffc4" : status === "demo" ? "#ffd45c" : status === "connecting" ? "#ffd45c" : "#ff6a1a";
  return (
    <div className="hud">
      <div className="title">
        DRONE<span>·</span>CITY
      </div>
      <div className="sub">HOLO GRID // variant C</div>
      <div className="row">
        <i style={{ background: statusColor, boxShadow: `0 0 8px ${statusColor}` }} />
        {mode === "hub" ? `HUB ${status.toUpperCase()}` : "DEMO FEED"}
      </div>
      <div className="stats">
        <b>{counts.active}</b> active <b>{counts.idle}</b> idle <b>{counts.ended}</b> ended
      </div>
      <div className="stats">
        <b>{counts.subs}</b> subagents out · <b>{rate}</b> ev/s
      </div>
      <div className="stats">
        <span style={{ color: machineColor("laptop") }}>◆ laptop {counts.laptop}</span>{" "}
        <span style={{ color: machineColor("vps") }}>◆ vps {counts.vps}</span>
      </div>
      {active + idle + ended === 0 ? (
        <div className="stats" style={{ marginTop: 8, color: "#ffd45c" }}>
          {mode === "hub" ? "waiting for sessions from the hub (ws://127.0.0.1:8787/ws) - add ?feed=demo for synthetic data" : "starting demo..."}
        </div>
      ) : null}
      <ScrollBar />
    </div>
  );
}

function ScrollBar() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const iv = setInterval(() => {
      const el = ref.current;
      if (!el) return;
      const f = scroll.max > 0.01 ? scroll.v / scroll.max : 0;
      el.style.top = `${f * 78}%`;
      el.style.opacity = scroll.max > 0.01 ? "1" : "0.25";
    }, 80);
    return () => clearInterval(iv);
  }, []);
  return (
    <div className="scroll-track">
      <div ref={ref} className="scroll-thumb" />
    </div>
  );
}

export function Legend() {
  return (
    <div className="legend">
      <div className="legend-title">BURST SYMBOLS</div>
      <div className="legend-grid">
        {LEGEND_ORDER.map((k) => (
          <div key={k} className="leg" title={SYM[k].hint}>
            <span style={{ color: SYM[k].color, textShadow: `0 0 8px ${SYM[k].color}` }}>{SYM[k].glyph}</span>
            <em>{SYM[k].label}</em>
          </div>
        ))}
      </div>
      <div className="legend-note">
        Bubble when ≥ {CFG.BUBBLE_RATE_THRESHOLD} ev/s or the drone is mid-animation. Ring colour = machine.
      </div>
    </div>
  );
}

function EventRow({ ev }: { ev: SessionEvent }) {
  const sym = symbolFor(ev);
  return (
    <div className={"ev" + (sym.key === "error" ? " bad" : "")}>
      <span className="t">{clock(ev.ts)}</span>
      <span className="g" style={{ color: sym.color }}>
        {sym.glyph}
      </span>
      <span className="k">
        {ev.tool ?? ev.kind}
        {ev.agentId ? <small> ↳{ev.agentId.slice(-4)}</small> : null}
      </span>
      <span className="d">{ev.detail ?? ""}</span>
      <span className="ms">{ev.durationMs != null ? `${ev.durationMs}ms` : ""}</span>
    </div>
  );
}

export function Inspect() {
  const sel = useCity((s) => (s.selectedId ? s.sessions[s.selectedId] : null)) as Session | null;
  const select = useCity((s) => s.select);
  const [, tick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, []);
  if (!sel) {
    return (
      <div className="panel empty">
        <div className="ph">INSPECT</div>
        <p>Click a drone or plate to read its session.</p>
        <p className="dim">Scroll or drag vertically to move through the districts.</p>
      </div>
    );
  }
  const mc = machineColor(sel.machine);
  const running = Object.values(sel.subagents).filter((x) => x.state === "running");
  const recent = [...sel.recent].reverse().slice(0, 22);
  return (
    <div className="panel" style={{ ["--mc" as string]: mc }}>
      <div className="ph">
        <span>INSPECT</span>
        <button onClick={() => select(null)}>✕</button>
      </div>
      <div className="big">{sel.label}</div>
      <div className="chips">
        <span className="chip" style={{ color: mc, borderColor: mc }}>
          {sel.machine.toUpperCase()}
        </span>
        <span className={"chip st-" + sel.state}>{sel.state.toUpperCase()}</span>
        {sel.role === "conductor" ? <span className="chip gold">⬢ CARRIER</span> : null}
      </div>
      <dl>
        <dt>session</dt>
        <dd>{sel.shortId}</dd>
        <dt>model</dt>
        <dd>{sel.model ?? "—"}</dd>
        <dt>tokens in/out</dt>
        <dd>
          {fmt(sel.tokens.input)} / {fmt(sel.tokens.output)}
        </dd>
        <dt>cache r/w</dt>
        <dd>
          {fmt(sel.tokens.cacheRead)} / {fmt(sel.tokens.cacheWrite)}
        </dd>
        <dt>cost</dt>
        <dd>${sel.costUsd.toFixed(2)}</dd>
        <dt>last event</dt>
        <dd>{ago(sel.lastEventAt)} ago</dd>
        <dt>subagents</dt>
        <dd>
          {running.length} out · {Object.keys(sel.subagents).length} total
        </dd>
      </dl>
      <div className="ph sm">RECENT EVENTS</div>
      <div className="evs">
        {recent.length ? recent.map((e) => <EventRow key={e.id} ev={e} />) : <p className="dim">no events yet</p>}
      </div>
    </div>
  );
}
