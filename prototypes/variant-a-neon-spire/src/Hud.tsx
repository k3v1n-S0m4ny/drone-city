import { useEffect, useState } from "react";
import {
  ANIM_MS,
  BUBBLE_MIN_INTERVAL_MS,
  machineColor,
} from "./config";
import { feedMode } from "./feed";
import { labelEls, rateEls } from "./labels";
import { stats } from "./runtime";
import { useStore } from "./store";
import { FAMILY_ORDER, SYMBOLS, eventFamily } from "./symbols";

function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

function Title() {
  const conn = useStore((s) => s.conn);
  const note = useStore((s) => s.connNote);
  useTick(500);
  const sessions = Object.values(useStore.getState().sessions);
  const by = { active: 0, idle: 0, ended: 0 };
  const mach: Record<string, number> = {};
  for (const s of sessions) {
    by[s.state]++;
    mach[s.machine] = (mach[s.machine] ?? 0) + 1;
  }
  return (
    <div className="panel title">
      <div className="logo">
        DRONE<span>/</span>CITY <em>NEON SPIRE</em>
      </div>
      <div className={"conn c-" + conn}>
        <i />
        {conn === "demo" ? "demo feed (synthetic)" : conn === "open" ? "hub connected" : conn === "connecting" ? "connecting to hub..." : "hub offline, retrying"}
      </div>
      {conn === "offline" && feedMode() === "hub" && (
        <div className="hint">
          nothing at {note}. start the hub or open <a href="?feed=demo">?feed=demo</a>
        </div>
      )}
      <div className="stats">
        <b>{by.active}</b> active <b>{by.idle}</b> idle <b>{by.ended}</b> ended
      </div>
      <div className="stats">
        {Object.entries(mach).map(([m, n]) => (
          <span key={m} className="mchip" style={{ ["--m" as string]: machineColor(m) }}>
            {m} {n}
          </span>
        ))}
      </div>
    </div>
  );
}

function Rate() {
  const [r, setR] = useState({ ev: 0, bub: 0 });
  useEffect(() => {
    let last = { e: stats.events, b: stats.bubbles, t: performance.now() };
    const id = setInterval(() => {
      const now = performance.now();
      const dt = (now - last.t) / 1000;
      setR({ ev: (stats.events - last.e) / dt, bub: (stats.bubbles - last.b) / dt });
      last = { e: stats.events, b: stats.bubbles, t: now };
    }, 500);
    return () => clearInterval(id);
  }, []);
  const storm = r.ev > 15;
  return (
    <div className={"panel rate" + (storm ? " storm" : "")}>
      <div className="big">
        {Math.round(r.ev)}
        <small> ev/s</small>
      </div>
      <div className="sub">
        {Math.round(r.bub)} bubbles/s · {r.ev > 0 ? Math.round((r.bub / r.ev) * 100) : 0}% burst
      </div>
      <div className="sub dimtxt">
        busy window {ANIM_MS.tool_result}ms · chip gap {BUBBLE_MIN_INTERVAL_MS}ms
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="panel legend">
      <div className="ptitle">BURST GLYPHS</div>
      <div className="lgrid">
        {FAMILY_ORDER.map((f) => {
          const s = SYMBOLS[f];
          return (
            <div key={f} className="lrow" title={s.hint}>
              <span className="chip" style={{ ["--c" as string]: s.color }}>
                {s.glyph}
              </span>
              <span className="lname">{s.name}</span>
            </div>
          );
        })}
      </div>
      <div className="lnote">
        <span className="mchip" style={{ ["--m" as string]: machineColor("laptop") }}>
          laptop = cyan trim
        </span>
        <span className="mchip" style={{ ["--m" as string]: machineColor("vps") }}>
          vps = amber trim
        </span>
      </div>
    </div>
  );
}

const fmt = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));

function Inspect() {
  const id = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  useTick(250);
  const s = id ? useStore.getState().sessions[id] : null;
  if (!s) return null;
  const now = Date.now();
  const subs = Object.values(s.subagents);
  return (
    <div className="panel inspect" style={{ ["--m" as string]: machineColor(s.machine) }}>
      <button className="x" onClick={() => select(null)} aria-label="close">
        ✕
      </button>
      <div className="ihead">
        <span className="iname">{s.role === "conductor" ? "◆ " : ""}{s.label}</span>
        <span className={"state st-" + s.state}>{s.state}</span>
      </div>
      <dl>
        <dt>machine</dt>
        <dd>
          <span className="mchip" style={{ ["--m" as string]: machineColor(s.machine) }}>
            {s.machine}
          </span>
        </dd>
        <dt>role</dt>
        <dd>{s.role === "conductor" ? "conductor (carrier)" : "session"}</dd>
        <dt>model</dt>
        <dd>{s.model ?? "-"}</dd>
        <dt>tokens</dt>
        <dd>
          in {fmt(s.tokens.input)} · out {fmt(s.tokens.output)}
          <br />
          cache r {fmt(s.tokens.cacheRead)} · w {fmt(s.tokens.cacheWrite)}
        </dd>
        <dt>cost</dt>
        <dd>${s.costUsd.toFixed(2)}</dd>
        <dt>subagents</dt>
        <dd>
          {subs.filter((x) => x.state === "running").length} running / {subs.length} total
        </dd>
        <dt>id</dt>
        <dd className="mono">{s.shortId}</dd>
      </dl>
      <div className="ptitle">RECENT EVENTS</div>
      <ul className="evlist">
        {s.recent
          .slice(-16)
          .reverse()
          .map((e) => {
            const f = SYMBOLS[eventFamily(e)];
            return (
              <li key={e.id}>
                <span className="chip sm" style={{ ["--c" as string]: f.color }}>
                  {f.glyph}
                </span>
                <span className="et">{e.tool ?? e.kind}</span>
                <span className="ed">{e.agentId ? `⤷ ${e.agentId.slice(0, 11)} ` : ""}{e.detail ?? ""}</span>
                <span className="ea">{Math.max(0, Math.round((now - e.ts) / 1000))}s</span>
              </li>
            );
          })}
      </ul>
    </div>
  );
}

function LabelLayer() {
  const order = useStore((s) => s.order);
  useStore((s) => s.struct);
  const sessions = useStore.getState().sessions;
  return (
    <div className="labels">
      {order.map((id) => {
        const s = sessions[id];
        if (!s) return null;
        return (
          <div
            key={id}
            className={"dlabel" + (s.state !== "active" ? " dim" : "")}
            style={{ ["--m" as string]: machineColor(s.machine), visibility: "hidden" }}
            ref={(el) => {
              if (el) labelEls.set(id, el);
              else labelEls.delete(id);
            }}
          >
            <span className="dl-id">{s.role === "conductor" ? "◆ " : ""}{s.label}</span>
            <span className="dl-m">{s.machine}</span>
            <span
              className="dl-rate"
              ref={(el) => {
                if (el) rateEls.set(id, el);
                else rateEls.delete(id);
              }}
            />
            {s.state !== "active" && <span className="dl-st">{s.state}</span>}
          </div>
        );
      })}
    </div>
  );
}

export function Hud() {
  return (
    <div className="hud">
      <LabelLayer />
      <Title />
      <Rate />
      <Legend />
      <Inspect />
      <div className="scrollhint">scroll / drag to move through districts · click a drone to inspect</div>
    </div>
  );
}
