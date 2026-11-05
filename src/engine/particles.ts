// A small Unity ParticleSystem for the web, driven by the settings exported from the
// original effects (lifetime, speed, size/colour over lifetime, gravity, emission rate
// and bursts, emitter shape, sprite sheets) and drawn with the original textures.
import { Assets, Container, Matrix, Sprite, Texture, Rectangle } from 'pixi.js';
import type { GO } from './scene';
import type { CompData } from './types';

const BASE = import.meta.env.BASE_URL + 'data/fx/';

type Range = [number, number];
type Keys = [number, number][];

export interface PSData {
  dur: number;
  loop: boolean;
  awake: boolean;
  delay: number;
  space: number;
  life: Range;
  speed: Range;
  size: Range;
  rot: Range;
  colors: number[][];
  gravity: number;
  max: number;
  rate: Range;
  bursts: [number, number][];
  shape: { type: number; angle: number; radius: number; pos: number[]; rot: number[]; scale: number[]; on: boolean };
  sizeOver?: Keys | null;
  colorOver?: { c: number[][]; a: Keys } | null;
  spin?: Range;
  vel?: [number, number];
  force?: [number, number];
  sheet?: [number, number, number];
}

interface Part {
  s: Sprite;
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  rot: number;
  spin: number;
  tint: number[];
  frame: number;
}

const rnd = (r: Range) => r[0] + Math.random() * (r[1] - r[0]);

function evalKeys(k: Keys | null | undefined, t: number, d = 1): number {
  if (!k || !k.length) return d;
  if (t <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++)
    if (t <= k[i][0]) {
      const [t0, v0] = k[i - 1];
      const [t1, v1] = k[i];
      return v0 + ((v1 - v0) * (t - t0)) / Math.max(1e-4, t1 - t0);
    }
  return k[k.length - 1][1];
}

function evalColour(g: { c: number[][]; a: Keys }, t: number): number[] {
  const a = evalKeys(g.a, t, 1);
  const cs = g.c;
  let rgb = cs[cs.length - 1]?.slice(1, 4) ?? [1, 1, 1];
  for (let i = 1; i < cs.length; i++)
    if (t <= cs[i][0]) {
      const k = (t - cs[i - 1][0]) / Math.max(1e-4, cs[i][0] - cs[i - 1][0]);
      rgb = [1, 2, 3].map((j) => cs[i - 1][j] + (cs[i][j] - cs[i - 1][j]) * k);
      break;
    }
  return [...rgb, a];
}

/** Emission direction in XY from the GO's world rotation and the shape's rotation (Unity cones emit along +Z). */
function quatRotate(q: number[], v: number[]): number[] {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}

function euler(deg: number[]): number[] {
  // Unity applies Z, then X, then Y
  const [x, y, z] = deg.map((d) => (d * Math.PI) / 360);
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  return [sx * cy * cz + cx * sy * sz, cx * sy * cz - sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
}

function qmul(a: number[], b: number[]): number[] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

const texCache = new Map<string, Texture>();
let fallback: Texture | null = null;

function softDot(): Texture {
  if (fallback) return fallback;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  fallback = Texture.from(c);
  return fallback;
}

export class Emitter {
  readonly view = new Container();
  playing = false;
  private t = 0;
  private acc = 0;
  private burstDone = new Set<number>();
  private parts: Part[] = [];
  private pool: Sprite[] = [];
  private tex: Texture = softDot();
  private frames: Texture[] | null = null;
  private wasActive = false;
  /** last emitter position, for systems that emit by distance moved */
  private lastPos: { x: number; y: number } | null = null;
  private hasTex = false;
  /** a parent whose child systems do the emitting (it only groups them) */
  container = false;
  /** water jets: tiny fast drops drawn as long lines */
  private readonly jet: boolean;

  constructor(
    readonly go: GO,
    readonly d: PSData,
    rend: CompData | undefined,
  ) {
    if (rend?.additive) this.view.blendMode = 'add';
    this.jet = /drop|water|spray|jet|nozzle|hose/i.test(`${go.name} ${go.parent?.name ?? ''} ${(rend?.tex as string) ?? ''}`);
    const key = rend?.tex as string | undefined;
    this.hasTex = !!key;
    if (key) {
      const hit = texCache.get(key);
      if (hit) this.setTex(hit);
      else
        void Assets.load<Texture>(BASE + key + '.webp').then((t) => {
          texCache.set(key, t);
          this.setTex(t);
        }).catch(() => undefined);
    }
  }

  private setTex(t: Texture): void {
    this.tex = t;
    const sh = this.d.sheet;
    if (sh && (sh[0] > 1 || sh[1] > 1)) {
      const [nx, ny] = sh;
      const w = t.width / nx;
      const h = t.height / ny;
      this.frames = [];
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) this.frames.push(new Texture({ source: t.source, frame: new Rectangle(t.frame.x + i * w, t.frame.y + j * h, w, h) }));
    }
  }

  play(): void {
    this.playing = true;
    this.t = -this.d.delay;
    this.acc = 0;
    this.burstDone.clear();
  }

  stop(clear = false): void {
    this.playing = false;
    if (clear) for (const p of this.parts.splice(0)) this.recycle(p);
  }

  /** World position + rotation of the GO (Unity units, y up). */
  private emitterFrame(world: Container): { x: number; y: number; m: Matrix } {
    // GameObject local -> world units
    const wm = world.worldTransform.clone().invert().append(this.go.view.worldTransform);
    return { x: wm.tx, y: wm.ty, m: wm };
  }

  /** Where the GO's local +Z axis points on screen (Unity units): a cone's forward.
   * The 2D matrix drops it, so it is rebuilt from the quaternions up the hierarchy. */
  private zImage(g: GO | undefined, world: Container): [number, number] {
    if (!g?.parent) return [0, 0];
    const q = g.data.q as number[];
    const sz = (g.data.scale as number[] | undefined)?.[2] ?? 1;
    const z = quatRotate([q[0], q[1], q[2], q[3]], [0, 0, sz]);
    const pm = world.worldTransform.clone().invert().append(g.parent.view.worldTransform);
    const zp = z[2] ? this.zImage(g.parent, world) : [0, 0];
    return [pm.a * z[0] + pm.c * z[1] + zp[0] * z[2], pm.b * z[0] + pm.d * z[1] + zp[1] * z[2]];
  }

  private zCache: [number, number] | null = null;

  private spawn(world: Container): void {
    if (this.parts.length >= Math.min(this.d.max, 400)) return;
    const { x, y, m } = this.emitterFrame(world);
    const zi = (this.zCache ??= this.zImage(this.go, world));
    const sh = this.d.shape;
    // position on the shape (in the emitter's local space)
    let lx = sh.pos[0];
    let ly = sh.pos[1];
    let dir: number[] = [0, 0, 1];
    const r = Math.max(0, sh.radius) * Math.sqrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    if (sh.on) {
      switch (sh.type) {
        case 0: // sphere
        case 1:
        case 2: // hemisphere
          dir = [Math.cos(a), Math.sin(a), 0];
          lx += dir[0] * r;
          ly += dir[1] * r;
          break;
        case 4: // cone
        case 8:
        case 10: // circle / edge
        default: {
          const sp = (Math.min(89, sh.angle) * Math.PI) / 180;
          const off = (Math.random() * 2 - 1) * sp;
          const local = quatRotate(euler(sh.rot), [Math.sin(off), 0, Math.cos(off)]);
          dir = local;
          const rp = quatRotate(euler(sh.rot), [Math.cos(a) * r, Math.sin(a) * r, 0]);
          lx += rp[0] * sh.scale[0];
          ly += rp[1] * sh.scale[1];
          break;
        }
        case 5: // box
          lx += (Math.random() - 0.5) * sh.scale[0];
          ly += (Math.random() - 0.5) * sh.scale[1];
          dir = quatRotate(euler(sh.rot), [0, 0, 1]);
          break;
      }
    }
    // emitter transform: m maps local -> world
    const wx = m.a * lx + m.c * ly + x;
    const wy = m.b * lx + m.d * ly + y;
    let dx = m.a * dir[0] + m.c * dir[1] + zi[0] * dir[2];
    let dy = m.b * dir[0] + m.d * dir[1] + zi[1] * dir[2];
    const len = Math.hypot(dx, dy);
    const unit = Math.max(1e-6, Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || Math.hypot(zi[0], zi[1]));
    if (len < 0.15 * unit) {
      // pointing at the camera: spread in the plane instead
      dx = Math.cos(a);
      dy = Math.sin(a);
    } else {
      dx /= len;
      dy /= len;
    }
    const speed = rnd(this.d.speed);
    const cols = this.d.colors;
    const c0 = cols[Math.floor(Math.random() * cols.length)] ?? [1, 1, 1, 1];
    const s = this.pool.pop() ?? new Sprite();
    s.anchor.set(0.5);
    const frame = this.frames ? Math.floor(Math.random() * this.frames.length) : 0;
    s.texture = this.frames ? this.frames[this.d.sheet?.[2] ? frame : 0] : this.tex;
    this.view.addChild(s);
    const spin = this.d.spin ? rnd(this.d.spin) : 0;
    // Unity scales particles with the transforms above the system (effects sit under tools scaled < 1)
    const hs = Math.min(1, Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1);
    this.parts.push({ s, x: wx, y: wy, vx: dx * speed, vy: dy * speed, age: 0, life: Math.max(0.05, rnd(this.d.life)), size: rnd(this.d.size) * hs, rot: rnd(this.d.rot), spin, tint: c0, frame });
  }

  private recycle(p: Part): void {
    p.s.removeFromParent();
    this.pool.push(p.s);
  }

  private get byDistance(): boolean {
    // only systems that draw something (empty parents have no texture)
    return this.hasTex && !this.container && this.d.loop && !this.d.bursts.length && !(this.d.rate[0] || this.d.rate[1]);
  }

  update(dt: number, world: Container): void {
    this.zCache = null;
    if (!this.playing) this.lastPos = null;
    const active = this.go.activeInHierarchy;
    if (active && !this.wasActive && this.d.awake) this.play();
    if (!active && this.wasActive) this.stop(true);
    this.wasActive = active;
    if (this.playing && active) {
      this.t += dt;
      if (this.t >= 0) {
        for (let i = 0; i < this.d.bursts.length; i++) {
          const [bt, n] = this.d.bursts[i];
          if (!this.burstDone.has(i) && this.t >= bt) {
            this.burstDone.add(i);
            for (let k = 0; k < Math.min(60, n); k++) this.spawn(world);
          }
        }
        this.acc += dt * rnd(this.d.rate);
        // no rate and no bursts: a tool trail (Unity's rate over distance, not exported):
        // emit as the emitter moves
        if (this.byDistance) {
          const { x, y } = this.emitterFrame(world);
          // plus a trickle while the tool works in place
          if (this.lastPos) this.acc += Math.min(2, Math.hypot(x - this.lastPos.x, y - this.lastPos.y)) * 18 + dt * 10;
          this.lastPos = { x, y };
        }
        while (this.acc >= 1) {
          this.acc -= 1;
          this.spawn(world);
        }
        if (this.t >= this.d.dur) {
          if (this.d.loop) {
            this.t -= this.d.dur;
            this.burstDone.clear();
          } else this.playing = false;
        }
      }
    }
    const g = -9.81 * this.d.gravity;
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) {
        this.recycle(p);
        this.parts.splice(i, 1);
        continue;
      }
      p.vy += g * dt;
      if (this.d.force) {
        p.vx += this.d.force[0] * dt;
        p.vy += this.d.force[1] * dt;
      }
      const vx = p.vx + (this.d.vel?.[0] ?? 0);
      const vy = p.vy + (this.d.vel?.[1] ?? 0);
      p.x += vx * dt;
      p.y += vy * dt;
      p.rot += p.spin * dt;
      const size = p.size * evalKeys(this.d.sizeOver, k, 1);
      const c = this.d.colorOver ? evalColour(this.d.colorOver, k) : [1, 1, 1, 1];
      const s = p.s;
      if (this.frames && this.d.sheet && !this.d.sheet[2]) s.texture = this.frames[Math.min(this.frames.length - 1, Math.floor(k * this.frames.length))];
      s.position.set(p.x, p.y);
      s.rotation = -p.rot;
      const tw = s.texture.width || 1;
      const th = s.texture.height || 1;
      // startSize is the particle's world size; the world is y-up, sprites are y-down
      const sc = size / Math.max(tw, th);
      const v = Math.hypot(vx, vy);
      if (v > 3.5 && !this.d.spin && size < 0.6) {
        // fast sprays are Unity's stretched billboards: a streak along the velocity
        // (a water jet is hundreds of tiny drops drawn as lines)
        s.rotation = Math.atan2(vy, vx);
        const jet = this.jet && size < 0.1;
        const len = Math.max(size * (1 + v * 0.18), v * (jet ? 0.07 : 0.02));
        const wid = Math.max(size * 0.8, jet ? 0.05 : 0);
        s.scale.set(len / tw, -wid / th);
      } else s.scale.set(sc, -sc);
      // HDR colours (> 1) are clamped
      const ch = (i: number) => Math.max(0, Math.min(255, Math.round(255 * p.tint[i] * c[i])));
      s.tint = (ch(0) << 16) | (ch(1) << 8) | ch(2);
      s.alpha = Math.max(0, Math.min(1, p.tint[3] * c[3]));
    }
  }

  get alive(): number {
    return this.parts.length;
  }
}

/** Emitters for every exported ParticleSystem of a level, keyed by GameObject id. */
export function buildEmitters(gos: GO[]): Map<number, Emitter> {
  const out = new Map<number, Emitter>();
  for (const g of gos) {
    const ps = g.comp('ParticleSystem');
    if (!ps || 'err' in ps || ps.dur === undefined) continue;
    out.set(g.id, new Emitter(g, ps as unknown as PSData, g.comp('ParticleSystemRenderer')));
  }
  markContainers(out);
  return out;
}

/** Mark parents whose children emit (they are only groups, not trails). */
export function markContainers(emitters: Map<number, Emitter>): void {
  const emits = (e: Emitter) => !!(e.d.rate[0] || e.d.rate[1] || e.d.bursts.length);
  for (const e of emitters.values()) {
    const stack = [...e.go.children];
    while (stack.length) {
      const o = stack.pop()!;
      const c = emitters.get(o.id);
      if (c && emits(c)) {
        e.container = true;
        break;
      }
      stack.push(...o.children);
    }
  }
}

/** Unity's Play() also plays the child systems. */
export function withChildren(g: GO, emitters: Map<number, Emitter>): Emitter[] {
  const out: Emitter[] = [];
  const stack = [g];
  while (stack.length) {
    const o = stack.pop()!;
    const e = emitters.get(o.id);
    if (e) out.push(e);
    stack.push(...o.children);
  }
  return out;
}
