import * as THREE from "three";
import { CFG, machineColor } from "./config";
import type { Session, SessionEvent } from "./types";
import { FAMILIES, SYM, symKey, toolFamily, type Family } from "./symbols";
import { getRT, rateOf } from "./runtime";
import { TOWER_R, towerPos } from "./iso";
import { lineMat, makeHexMat } from "./glow";
import { Towers } from "./towers";
import { Pulses } from "./pulses";
import { DroneObj } from "./droneObj";
import { DroneFx, ANIM_MS } from "./fx";
import { Subagents } from "./subagents";
import { Ticker } from "./ticker";
import { Label } from "./label";
import { Ribbon } from "./ribbon";

const R = () => CFG.HEX_R;
const hexPts = (r: number, y: number) => {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
  }
  return pts;
};

export interface Slot {
  x: number;
  z: number;
  state: "active" | "idle" | "ended";
}

const FADE_BY_STATE = { active: 1, idle: 0.62, ended: 0.3 } as const;
const SINK_BY_STATE = { active: 0, idle: -0.3, ended: -0.8 } as const;
const HOVER_BY_STATE = { active: 1, idle: 0.72, ended: 0.18 } as const;

const famIndex = (f: Family) => (f === "other" ? 6 : FAMILIES.indexOf(f));

/**
 * Everything for one session: hex plate, towers, traces, drone (or carrier),
 * subagents, pulses, effect pool, burst ticker and label. Plain three.js; React
 * only mounts `root` and calls update() every frame.
 */
export class District {
  root = new THREE.Group();
  readonly id: string;
  readonly carrier: boolean;
  private machine: string;
  private first = true;
  private fade = 1;
  private hexMat: THREE.ShaderMaterial;
  private fades: { m: THREE.Material; base: number }[] = [];
  private select: THREE.LineLoop;
  private selMat: THREE.LineBasicMaterial;
  towers = new Towers();
  private pulses = new Pulses();
  drone: DroneObj;
  private fx = new DroneFx();
  private subs: Subagents;
  private ticker = new Ticker();
  private label = new Label();
  private trail: Ribbon;
  plate: THREE.Mesh;
  private glass: THREE.MeshBasicMaterial;

  // dynamic state
  private dp = new THREE.Vector3(0, 3, 0);
  private vel = new THREE.Vector3();
  private act = 0;
  private busyUntil = 0;
  private lastPulse = 0;
  private fxTower = 6;
  private ringT = 1;
  private phase: number;
  private rate = 0;
  private lastSubRef: unknown = null;
  private anon = 0;
  private tmpTop = new THREE.Vector3();
  private tmpBase = new THREE.Vector3();
  private tmpStart = new THREE.Vector3();
  private hoverK = 1;
  private droneScale = 1;
  private shakeV = new THREE.Vector3();

  constructor(s: Session) {
    this.id = s.id;
    this.carrier = s.role === "conductor";
    this.machine = s.machine;
    this.phase = [...s.id].reduce((a, c) => a + c.charCodeAt(0), 0) % 100;
    const mc = new THREE.Color(machineColor(s.machine));
    const r = R();

    // ---- plate ----
    this.hexMat = makeHexMat(r);
    this.hexMat.uniforms.uColor.value = mc.clone();
    this.plate = new THREE.Mesh(new THREE.CircleGeometry(r, 6, Math.PI / 6).rotateX(-Math.PI / 2), this.hexMat);
    this.plate.position.y = 0.01;
    this.plate.renderOrder = -1;
    this.root.add(this.plate);
    const glass = new THREE.Mesh(
      this.plate.geometry,
      new THREE.MeshBasicMaterial({ color: "#01070d", transparent: true, opacity: 0.8, depthWrite: false }),
    );
    glass.position.y = 0.004;
    glass.renderOrder = -3;
    this.glass = glass.material as THREE.MeshBasicMaterial;
    this.root.add(glass);

    const rim = lineMat(mc.clone().lerp(new THREE.Color("#ffffff"), 0.25), 1);
    rim.color.multiplyScalar(1.6);
    this.root.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(hexPts(r, 0.03)), rim));
    const rim2 = lineMat(mc, 0.4);
    this.root.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(hexPts(r - 0.3, 0.03)), rim2));
    // vertex ticks
    const tick: THREE.Vector3[] = [];
    hexPts(r, 0.03).forEach((p) => {
      const d = p.clone().normalize();
      tick.push(p.clone().addScaledVector(d, -0.35), p.clone().addScaledVector(d, 0.3));
    });
    const tickMat = lineMat("#eafcff", 0.9);
    this.root.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(tick), tickMat));
    this.fades.push({ m: rim, base: 1 }, { m: rim2, base: 0.4 }, { m: tickMat, base: 0.9 });

    // selection brackets
    this.selMat = lineMat("#ffffff", 0);
    this.select = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(hexPts(r + 0.38, 0.05)), this.selMat);
    this.root.add(this.select);

    // ---- circuit traces + tower pads ----
    const tr: THREE.Vector3[] = [];
    const pad: THREE.Vector3[] = [];
    for (let k = 0; k < 6; k++) {
      const [tx, tz] = towerPos(k);
      tr.push(new THREE.Vector3(0, 0.04, 0), new THREE.Vector3(0, 0.04, tz), new THREE.Vector3(0, 0.04, tz), new THREE.Vector3(tx, 0.04, tz));
      const w = 0.62 * 0.78;
      const c4 = [[-w, -w], [w, -w], [w, w], [-w, w]];
      for (let i = 0; i < 4; i++) {
        const a = c4[i], b = c4[(i + 1) % 4];
        pad.push(new THREE.Vector3(tx + a[0], 0.04, tz + a[1]), new THREE.Vector3(tx + b[0], 0.04, tz + b[1]));
      }
    }
    const traceMat = lineMat(mc, 0.55);
    const padMat = lineMat("#3be8ff", 0.7);
    this.root.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(tr), traceMat));
    this.root.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pad), padMat));
    const hubMat = lineMat("#bff6ff", 0.8);
    this.root.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(hexPts(1.25, 0.04)), hubMat));
    this.fades.push({ m: traceMat, base: 0.55 }, { m: padMat, base: 0.7 }, { m: hubMat, base: 0.8 });
    void TOWER_R;

    // ---- towers / pulses ----
    this.root.add(this.towers.root);
    this.root.add(this.pulses.mesh);
    this.pulses.onArrive = (k, c) => {
      this.towers.hit(k, c, 0.4);
      this.hexMat.uniforms.uFlash.value = Math.min(1, this.hexMat.uniforms.uFlash.value + 0.12);
    };

    // ---- drone / carrier ----
    this.drone = new DroneObj(s.machine, this.carrier);
    this.root.add(this.drone.root);
    this.root.add(this.fx.root);
    this.subs = new Subagents(this.carrier ? 12 : 4, mc);
    this.root.add(this.subs.root);
    this.trail = new Ribbon(30, mc.clone().lerp(new THREE.Color("#ffffff"), 0.35));
    this.root.add(this.trail.mesh);
    this.trail.reset(this.dp);

    // ---- bubbles / label ----
    this.ticker.setMachine(s.machine);
    this.root.add(this.ticker.group);
    this.label.sprite.position.set(0, 0.5, r - 0.78);
    this.root.add(this.label.sprite);

    // the plate and the drone are the only clickable parts
    this.root.traverse((o) => {
      if (o !== this.plate && o !== this.drone.hit) o.raycast = () => {};
    });
  }

  dispose() {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && !(m.geometry as { userData?: { shared?: boolean } }).userData?.shared) m.geometry.dispose?.();
    });
  }

  // ------------------------------------------------------------------ events --
  private towerFor(ev: SessionEvent): number {
    if (ev.kind === "tool_result" || ev.kind === "tool_decision" || ev.kind === "subagent_spawn" || ev.kind === "subagent_done") {
      return famIndex(toolFamily(ev.tool));
    }
    return 6;
  }

  private startAnim(key: string, tower: number, now: number) {
    this.fx.play(key, now);
    this.fxTower = tower;
    this.busyUntil = now + Math.max(CFG.ANIM_SLOT_MS, ANIM_MS[key] ?? 0);
  }

  private consume(now: number, sess: Session) {
    const r = getRT(this.id);
    this.rate = rateOf(r.arrivals, now, CFG.BUBBLE_WINDOW_MS);
    const burst = this.rate >= CFG.BUBBLE_RATE_THRESHOLD;
    if (r.queue.length > 80) r.queue.splice(0, r.queue.length - 80);
    while (r.queue.length) {
      const ev = r.queue.shift()!;
      const key = symKey(ev);
      const sym = SYM[key] ?? SYM.other;
      const tower = this.towerFor(ev);
      this.act = Math.min(1, this.act + 0.3);

      // ---- subagent lifecycle ----
      if (ev.kind === "subagent_spawn") {
        this.subs.spawn(ev.agentId ?? `anon-${this.anon++}`, now);
        this.startAnim("agent", 4, now);
        if (burst) this.ticker.push(sym, now);
        continue;
      }
      if (ev.kind === "subagent_done") {
        this.subs.dock(ev.agentId, now);
        if (burst) this.ticker.push(sym, now);
        continue;
      }
      if (ev.agentId && !this.subs.has(ev.agentId)) this.subs.spawn(ev.agentId, now);

      const own = ev.agentId == null;
      const busy = now < this.busyUntil;
      if (!own) {
        this.subs.poke(ev.agentId);
        if (burst || busy) this.ticker.push(sym, now);
      } else if (key === "error") {
        this.startAnim("error", tower, now); // errors always preempt
        if (burst) this.ticker.push(sym, now);
      } else if (!burst && !busy) {
        this.startAnim(key, tower, now);
      } else {
        this.ticker.push(sym, now); // burst bubble instead of queuing an animation
      }

      // light-weight travelling pulse (rate limited) so activity stays visible in bursts
      if (now - this.lastPulse > CFG.PULSE_MIN_GAP_MS) {
        this.lastPulse = now;
        const start = this.tmpStart;
        if (own || !this.subs.posOf(ev.agentId, start)) start.copy(this.dp);
        this.towers.topOf(tower, this.tmpTop);
        this.pulses.spawn(start, tower, this.tmpTop.y, sym.color);
      }
    }
    void sess;
  }

  private reconcileSubs(sess: Session, now: number) {
    if (sess.subagents === this.lastSubRef) return;
    this.lastSubRef = sess.subagents;
    for (const sa of Object.values(sess.subagents)) {
      if (sa.state === "running") {
        if (!this.subs.has(sa.id)) this.subs.spawn(sa.id, now, Date.now() - sa.startedAt > 4000);
      } else if (this.subs.has(sa.id)) {
        this.subs.dock(sa.id, now);
      }
    }
  }

  // ------------------------------------------------------------------ frame ---
  update(dt: number, t: number, now: number, sess: Session, slot: Slot, selected: boolean) {
    // machine / label
    if (sess.machine !== this.machine) this.machine = sess.machine;
    this.label.set(sess.label, sess.machine, sess.state, sess.role);

    // glide to slot
    const k = 1 - Math.exp(-dt * 3.2);
    const sink = SINK_BY_STATE[slot.state];
    if (this.first) {
      this.root.position.set(slot.x, sink, slot.z);
      this.first = false;
    } else {
      this.root.position.x += (slot.x - this.root.position.x) * k;
      this.root.position.z += (slot.z - this.root.position.z) * k;
      this.root.position.y += (sink - this.root.position.y) * k;
    }
    const st = sess.state;
    this.fade += (FADE_BY_STATE[st] - this.fade) * (1 - Math.exp(-dt * 2));
    const fade = this.fade;

    this.reconcileSubs(sess, now);
    this.consume(now, sess);
    this.act *= Math.exp(-dt * 1.6);

    // ---- plate ----
    const hu = this.hexMat.uniforms;
    hu.uTime.value = t;
    hu.uAlpha.value = fade;
    hu.uFlash.value *= Math.exp(-dt * 4);
    hu.uSel.value += ((selected ? 1 : 0) - hu.uSel.value) * (1 - Math.exp(-dt * 8));
    if (this.ringT >= 1) {
      if (this.act > 0.35) this.ringT = 0;
    } else this.ringT += dt / 1.4;
    hu.uRing.value = this.ringT >= 1 ? 0 : this.ringT;
    for (const f of this.fades) f.m.opacity = f.base * fade;
    this.glass.opacity = 0.8 * Math.max(0.35, fade);
    this.selMat.opacity = hu.uSel.value * (0.65 + 0.35 * Math.sin(t * 5));
    this.select.scale.setScalar(1 + 0.012 * Math.sin(t * 3));

    // ---- towers ----
    const rtc = getRT(this.id).counts;
    const sat: number[] = [];
    for (let i = 0; i < 6; i++) sat.push(Math.min(3.4, 0.35 + 0.3 * Math.sqrt(rtc[FAMILIES[i]])));
    const tk = sess.tokens.input + sess.tokens.output + sess.tokens.cacheWrite;
    this.towers.setHeights(sat, Math.min(4.6, 0.7 + 0.62 * Math.log10(1 + tk / 500)));
    this.towers.update(dt, t, fade, this.act);
    this.pulses.update(dt, fade);

    // ---- drone ----
    const coreH = this.towers.items[6].h;
    const hover = Math.max(this.carrier ? 3.9 : 3.3, coreH + (this.carrier ? 1.9 : 1.5)) * HOVER_BY_STATE[st] + Math.sin(t * 1.1 + this.phase) * 0.12;
    this.hoverK += (HOVER_BY_STATE[st] - this.hoverK) * k;
    const lean = this.fx.lean;
    const [lx, lz] = this.fxTower < 6 ? towerPos(this.fxTower) : [0, 0];
    const wx = Math.sin(t * 0.55 + this.phase) * 0.45;
    const wz = Math.cos(t * 0.41 + this.phase * 1.3) * 0.38;
    const tx = wx + lx * 0.3 * lean;
    const tz = wz + lz * 0.3 * lean;
    const kd = 1 - Math.exp(-dt * 5);
    this.vel.set(tx - this.dp.x, hover - this.dp.y, tz - this.dp.z);
    this.dp.addScaledVector(this.vel, kd);
    const shake = this.fx.shake;
    this.shakeV.set((Math.random() - 0.5) * 0.3 * shake, (Math.random() - 0.5) * 0.2 * shake, (Math.random() - 0.5) * 0.3 * shake);
    const dr = this.drone;
    dr.root.position.copy(this.dp).add(this.shakeV);
    const alive = st !== "ended";
    this.droneScale += ((alive ? 1 : 0.4) - this.droneScale) * (1 - Math.exp(-dt * 3));
    dr.root.scale.setScalar(this.droneScale);
    const spin = (0.9 + this.act * 5 + this.rate * 0.05) * (st === "idle" ? 0.35 : 1);
    dr.core.rotation.y += dt * spin * 0.8;
    dr.core.rotation.x = Math.sin(t * 0.9 + this.phase) * 0.12;
    (dr.ringA.userData.spin as THREE.Group).rotation.y += dt * spin * 1.2;
    (dr.ringB.userData.spin as THREE.Group).rotation.y -= dt * spin * 1.6;
    dr.ringA.rotation.y += dt * 0.25;
    dr.ringB.rotation.y -= dt * 0.18;
    dr.coreEdge.color.set("#cfeffa").multiplyScalar(0.8 + this.act * 0.7);
    dr.hit.position.set(0, 0, 0);
    const boost = 1.7 + this.act * 1.6;
    for (const m of dr.ringMats) m.color.set(machineColor(this.machine)).multiplyScalar(boost);
    if (dr.station && dr.stationArcs) {
      dr.station.rotation.y += dt * 0.12;
      dr.stationArcs.rotation.y -= dt * 0.35;
      const fl = this.subs.ringFlash;
      for (const m of dr.stationMats) m.color.set(machineColor(this.machine)).multiplyScalar(1.4 + fl * 2.5);
      dr.portMats.forEach((m, i) => m.color.set("#eafcff").multiplyScalar(1 + (i === this.subs.flashPort ? fl * 4 : 0)));
    }
    dr.setFade(fade * (alive ? 1 : 0.6));

    // trail follows the drone
    this.trail.push(this.dp);
    this.trail.intensity = fade * (alive ? 1 : 0);
    this.trail.update(this.carrier ? 0.14 : 0.1);

    // fx
    this.towers.topOf(this.fxTower, this.tmpTop);
    this.tmpBase.set(this.towers.items[this.fxTower].pos.x, 0.07, this.towers.items[this.fxTower].pos.z);
    this.fx.update(now, this.dp, this.tmpTop, this.tmpBase);

    // subagents
    this.subs.update(dt, t, now, hover, dr, fade, this.dp);

    // ticker
    const lift = this.carrier ? 1.75 : 1.05;
    this.ticker.group.position.set(this.dp.x, this.dp.y + lift, this.dp.z);
    this.ticker.baseScale = this.carrier ? 1.12 : 1;
    this.ticker.update(dt, now, this.rate, alive);
    this.root.userData.rate = this.rate;
  }
}
