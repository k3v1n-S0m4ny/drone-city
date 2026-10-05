import { useEffect, useRef, useState } from "react";
import { BubbleLayer } from "./bubbles";
import { CFG, machineInfo } from "./config";
import { feedMode, startFeed } from "./feed";
import { sim } from "./sim";
import { eventsPerSecond, select, useStore, world } from "./store";
import { FAMILIES, FAMILY_ORDER, familyOf } from "./symbols";
import { Scene } from "./scene/Scene";
import { view } from "./scene/view";
import type { SessionEvent } from "./types";

export function App() {
  const bubbleRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stop = startFeed();
    (window as any).__sim = sim;
    (window as any).__world = world;
    const layer = new BubbleLayer(bubbleRoot.current!);
    let raf = 0;
    const loop = () => {
      layer.update(performance.now());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      stop();
      cancelAnimationFrame(raf);
    };
  }, []);
  return (
    <>
      <Scene />
      <div ref={bubbleRoot} className="bubbles" />
      <Hud />
      <Legend />
      <ScrollBar />
      <Inspect />
    </>
  );
}

function Hud() {
  useStore((s) => s.version);
  const status = useStore((s) => s.status);
  const statusText = useStore((s) => s.statusText);
  const [eps, setEps] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setEps(eventsPerSecond()), 250);
    return () => clearInterval(t);
  }, []);
  const all = Object.values(world.sessions);
  const act = all.filter((s) => s.state === "active").length;
  const idle = all.filter((s) => s.state === "idle").length;
  const end = all.filter((s) => s.state === "ended").length;
  let anim = 0, bub = 0;
  for (const r of sim.all()) { anim += r.animated; bub += r.bubbled; }
  return (
    <div className="hud panel">
      <div className="title">
        <span className="drop" />RAIN HARBOR <em>drone-city / B</em>
      </div>
      <div className={`feed ${status}`}>
        <i /> {feedMode() === "demo" ? "DEMO FEED" : "HUB"} · {status}
        <span className="dim"> {statusText}</span>
      </div>
      <div className="stats">
        <span><b>{act}</b> active</span>
        <span><b>{idle}</b> idle</span>
        <span><b>{end}</b> ended</span>
        <span className={eps > 25 ? "hot" : ""}><b>{eps}</b> ev/s</span>
      </div>
      <div className="stats dim">
        <span>{anim} animated</span>
        <span>{bub} bubbled</span>
        <span>thr {CFG.BUBBLE_THRESHOLD_MS}ms</span>
      </div>
      {feedMode() === "demo" && (
        <button className="storm" onClick={() => (window as any).__demo?.storm(7000)}>force tool storm</button>
      )}
    </div>
  );
}

function Legend() {
  const [open, setOpen] = useState(true);
  return (
    <div className="legend panel">
      <div className="lhead" onClick={() => setOpen(!open)}>
        SYMBOLS <span className="dim">{open ? "[-]" : "[+]"}</span>
      </div>
      {open && (
        <>
          <div className="lgrid">
            {FAMILY_ORDER.map((f) => (
              <div key={f} className="lrow" style={{ ["--c" as any]: FAMILIES[f].color }}>
                <span className="chip static"><b className="g">{FAMILIES[f].glyph}</b></span>
                <span className="lt">{FAMILIES[f].label}</span>
                <span className="la">{FAMILIES[f].anim}</span>
              </div>
            ))}
          </div>
          <div className="lfoot">
            <span><i className="mdot" style={{ background: machineInfo("laptop").hex }} />laptop hull</span>
            <span><i className="mdot" style={{ background: machineInfo("vps").hex }} />vps hull</span>
            <span className="dim">+N = overflow · xN = repeats</span>
          </div>
        </>
      )}
    </div>
  );
}

function ScrollBar() {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const e = el.current;
      if (e) {
        const max = Math.max(1, view.maxScroll);
        const f = Math.min(1, view.scroll / max);
        e.style.display = view.maxScroll > 0.5 ? "block" : "none";
        e.style.top = `${f * 78}%`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="scrolltrack">
      <div ref={el} className="scrollthumb" />
      <span className="hint">scroll</span>
    </div>
  );
}

function ago(ts: number) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  return s < 90 ? `${s.toFixed(0)}s` : `${(s / 60).toFixed(0)}m`;
}
const fmt = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));

function Inspect() {
  const selected = useStore((s) => s.selected);
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 300);
    return () => clearInterval(t);
  }, []);
  const s = selected ? world.sessions[selected] : undefined;
  if (!s) return null;
  const info = machineInfo(s.machine);
  const subs = Object.values(s.subagents);
  const rt = sim.rt(s.id, null);
  const recent = [...s.recent].reverse().slice(0, 16);
  return (
    <div className="panel inspect" style={{ ["--m" as any]: info.hex }}>
      <div className="ihead">
        <div>
          <div className="ilabel">{s.label}</div>
          <div className="isub">
            <span className="badge" style={{ background: info.hex }}>{info.label}</span>
            <span className={`state ${s.state}`}>{s.state}</span>
            {s.role === "conductor" && <span className="role">carrier</span>}
          </div>
        </div>
        <button onClick={() => select(null)}>x</button>
      </div>
      <dl>
        <dt>session</dt><dd>{s.shortId}</dd>
        <dt>model</dt><dd>{s.model ?? "-"}</dd>
        <dt>tokens</dt>
        <dd>in {fmt(s.tokens.input)} / out {fmt(s.tokens.output)}<br />cache r {fmt(s.tokens.cacheRead)} / w {fmt(s.tokens.cacheWrite)}</dd>
        <dt>cost</dt><dd>${s.costUsd.toFixed(2)}</dd>
        <dt>last event</dt><dd>{ago(s.lastEventAt)} ago</dd>
        <dt>subagents</dt><dd>{subs.filter((x) => x.state === "running").length} airborne / {subs.length} tracked</dd>
        <dt>anim / chips</dt><dd>{rt.animated} / {rt.bubbled}</dd>
      </dl>
      <div className="evhead">RECENT EVENTS</div>
      <div className="evlist">
        {recent.map((e: SessionEvent) => {
          const f = familyOf(e);
          const d = f ? FAMILIES[f] : null;
          return (
            <div key={e.id} className="ev" style={{ ["--c" as any]: d?.color ?? "#6a7a86" }}>
              <span className="chip static"><b className="g">{d?.glyph ?? "·"}</b></span>
              <span className="evk">{e.tool ?? e.kind}{e.agentId ? " (sub)" : ""}</span>
              <span className="evd">{e.detail ?? ""}</span>
              <span className="evt">{ago(e.ts)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
