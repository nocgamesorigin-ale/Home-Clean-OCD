// Particle effects and the tutorial hand.
//
// The original ParticleSystems are not exported with their settings, so each one is
// drawn in a style picked from its name (Star_Clean -> sparkles, SoapBubble -> bubbles,
// Smoke/Dust -> dust puffs, Water -> droplets, Fire -> flames).
import { Assets, Container, Sprite, Texture, type Point } from 'pixi.js';

export type FxKind =
  | 'sparkle' | 'bubble' | 'dust' | 'drop' | 'fire' | 'leaf'
  // streams: shot from the emitter toward an aim point (the tool's working spot)
  | 'spray' | 'foam' | 'paint' | 'wind' | 'suck'
  | 'spark' | 'mud' | 'chip' | 'dirtydrop' | 'smoke';

const STREAM = new Set<FxKind>(['spray', 'foam', 'paint', 'wind', 'suck']);

const PAINT: Record<string, string> = {
  red: 'rgba(225,50,45,0.95)', blue: 'rgba(40,110,230,0.95)', green: 'rgba(60,180,70,0.95)', yellow: 'rgba(250,210,40,0.95)',
  purple: 'rgba(150,70,200,0.95)', black: 'rgba(30,30,35,0.95)', white: 'rgba(250,250,250,0.95)', brown: 'rgba(120,75,40,0.95)',
};

interface P {
  s: Sprite;
  vx: number;
  vy: number;
  life: number;
  max: number;
  spin: number;
  grow: number;
  gravity: number;
  size: number;
}

const tex = new Map<string, Texture>();

function canvasTex(name: string, draw: (g: CanvasRenderingContext2D) => void): Texture {
  const hit = tex.get(name);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  draw(c.getContext('2d')!);
  const t = Texture.from(c);
  tex.set(name, t);
  return t;
}

function soft(color: string): Texture {
  return canvasTex('soft' + color, (g) => {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, color);
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
  });
}

function star(): Texture {
  return canvasTex('star', (g) => {
    g.translate(32, 32);
    const r = g.createRadialGradient(0, 0, 0, 0, 0, 30);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.25, 'rgba(255,250,210,.9)');
    r.addColorStop(1, 'rgba(255,240,180,0)');
    g.fillStyle = r;
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const rr = i % 2 ? 6 : 30;
      g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    g.closePath();
    g.fill();
  });
}

function bubble(): Texture {
  return canvasTex('bubble', (g) => {
    const r = g.createRadialGradient(26, 24, 2, 32, 32, 30);
    r.addColorStop(0, 'rgba(255,255,255,.9)');
    r.addColorStop(0.55, 'rgba(220,240,255,.25)');
    r.addColorStop(0.9, 'rgba(255,255,255,.75)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.beginPath();
    g.arc(32, 32, 30, 0, Math.PI * 2);
    g.fill();
  });
}

/** Style of a ParticleSystem from its GameObject name (the original effect names). */
export function kindOf(name: string): FxKind {
  const n = name.toLowerCase();
  if (/spray_paint|paint_spray/.test(n)) return 'paint';
  if (/wind_in|vacuum|suck/.test(n)) return 'suck';
  if (/wind|blower|dryer|air/.test(n)) return 'wind';
  if (/apray_foam|spray_foam|spray_detergent|foam_cannon|detergent/.test(n)) return 'foam';
  if (/nozzle|spray_bottle_water|water_spray|water_nozzle|hose/.test(n)) return 'spray';
  if (/dirty_drop|water_dirty/.test(n)) return 'dirtydrop';
  if (/impact|grind|spark|weld/.test(n)) return 'spark';
  if (/mud/.test(n)) return 'mud';
  if (/ice|glass|chip|brick|rock|splashes/.test(n)) return 'chip';
  if (/smoke|steam/.test(n)) return 'smoke';
  if (/bubble|soap|foam|xa_phong|mop/.test(n)) return 'bubble';
  if (/dust|dirt|moss|trash|sand|ash|powder|wood|cobweb|shovel|tiller/.test(n)) return 'dust';
  if (/water|drop|splash|rain|wet/.test(n)) return 'drop';
  if (/fire|flame|burn|torch|lighter/.test(n)) return 'fire';
  if (/leaf|leaves|grass|lawn|la_/.test(n)) return 'leaf';
  return 'sparkle';
}

/** Spray paint colour from the effect name. */
function paintColour(name: string): string {
  const n = name.toLowerCase();
  for (const k of Object.keys(PAINT)) if (n.includes(k)) return PAINT[k];
  return PAINT.white;
}

export class Fx {
  readonly view = new Container();
  private ps: P[] = [];
  private pool: Sprite[] = [];
  private loops = new Map<string, { kind: FxKind; at: () => Point | null; aim?: () => Point | null; acc: number; rate: number; tint?: string }>();

  /** One burst of n particles at a world point (Unity units). */
  burst(kind: FxKind, x: number, y: number, n = 12, spread = 0.5): void {
    for (let i = 0; i < n; i++) this.spawn(kind, x + (Math.random() - 0.5) * spread, y + (Math.random() - 0.5) * spread);
  }

  /** A continuous emitter, until stop(id). Streams fly from `at` toward `aim`. */
  loop(id: string, kind: FxKind, at: () => Point | null, aim?: () => Point | null, name = ''): void {
    const rate = STREAM.has(kind) ? 70 : kind === 'dirtydrop' || kind === 'spark' ? 30 : kind === 'smoke' ? 14 : 18;
    this.loops.set(id, { kind, at, aim, acc: 0, rate, tint: kind === 'paint' ? paintColour(name) : undefined });
  }

  stop(id: string): void {
    this.loops.delete(id);
  }

  stopAll(): void {
    this.loops.clear();
  }

  private spawn(kind: FxKind, x: number, y: number, aim?: Point | null, tint?: string): void {
    const s = this.pool.pop() ?? new Sprite();
    s.anchor.set(0.5);
    s.alpha = 1;
    s.rotation = Math.random() * Math.PI * 2;
    let size = 0.25;
    const p: P = { s, vx: 0, vy: 0, life: 0, max: 1, spin: 0, grow: 0, gravity: 0, size };
    switch (kind) {
      case 'sparkle':
        s.texture = star();
        size = 0.25 + Math.random() * 0.35;
        p.vx = (Math.random() - 0.5) * 1.6;
        p.vy = Math.random() * 1.6;
        p.max = 0.6 + Math.random() * 0.5;
        p.spin = (Math.random() - 0.5) * 4;
        break;
      case 'bubble':
        s.texture = bubble();
        size = 0.12 + Math.random() * 0.3;
        p.vx = (Math.random() - 0.5) * 0.6;
        p.vy = 0.3 + Math.random() * 0.8;
        p.max = 0.9 + Math.random() * 0.8;
        p.grow = 0.2;
        break;
      case 'dust':
        s.texture = soft('rgba(150,125,95,0.55)');
        size = 0.35 + Math.random() * 0.5;
        p.vx = (Math.random() - 0.5) * 1.2;
        p.vy = 0.2 + Math.random() * 0.6;
        p.max = 0.7 + Math.random() * 0.6;
        p.grow = 0.8;
        break;
      case 'drop':
        s.texture = soft('rgba(170,215,255,0.9)');
        size = 0.08 + Math.random() * 0.12;
        p.vx = (Math.random() - 0.5) * 2.2;
        p.vy = 0.6 + Math.random() * 1.6;
        p.gravity = -7;
        p.max = 0.5 + Math.random() * 0.3;
        break;
      case 'fire':
        s.texture = soft(Math.random() < 0.5 ? 'rgba(255,170,50,0.9)' : 'rgba(255,90,30,0.85)');
        size = 0.3 + Math.random() * 0.3;
        p.vx = (Math.random() - 0.5) * 0.5;
        p.vy = 0.8 + Math.random() * 1.2;
        p.max = 0.5 + Math.random() * 0.4;
        p.grow = -0.4;
        break;
      case 'leaf':
        s.texture = soft('rgba(120,170,70,0.8)');
        size = 0.15 + Math.random() * 0.15;
        p.vx = (Math.random() - 0.5) * 1.5;
        p.vy = 0.5 + Math.random();
        p.gravity = -3;
        p.spin = (Math.random() - 0.5) * 6;
        p.max = 0.8;
        break;
      case 'spray':
      case 'foam':
      case 'paint':
      case 'wind':
      case 'suck': {
        s.texture =
          kind === 'spray' ? soft('rgba(200,230,255,0.85)')
          : kind === 'foam' ? bubble()
          : kind === 'paint' ? soft(tint ?? PAINT.white)
          : soft('rgba(235,245,255,0.55)');
        size = kind === 'foam' ? 0.12 + Math.random() * 0.22 : kind === 'paint' ? 0.12 + Math.random() * 0.16 : kind === 'spray' ? 0.07 + Math.random() * 0.12 : 0.1 + Math.random() * 0.2;
        // from the nozzle to the working spot (vacuum: the other way round)
        let fx = x;
        let fy = y;
        let tx = aim?.x ?? x;
        let ty = aim?.y ?? y - 1.5;
        if (kind === 'suck') [fx, fy, tx, ty] = [tx + (Math.random() - 0.5) * 1.2, ty + (Math.random() - 0.5) * 1.2, x, y];
        const dx = tx - fx;
        const dy = ty - fy;
        const d = Math.max(0.3, Math.hypot(dx, dy));
        const speed = kind === 'wind' || kind === 'suck' ? 7 : 9;
        const spread = kind === 'paint' ? 0.12 : 0.22;
        const nx = dx / d + (Math.random() - 0.5) * spread * 2;
        const ny = dy / d + (Math.random() - 0.5) * spread * 2;
        x = fx;
        y = fy;
        p.vx = nx * speed;
        p.vy = ny * speed;
        p.max = (d / speed) * (0.85 + Math.random() * 0.35);
        p.grow = kind === 'spray' || kind === 'paint' ? 1.6 : kind === 'wind' ? 2 : 0.5;
        break;
      }
      case 'dirtydrop':
      case 'mud':
        s.texture = soft(kind === 'mud' ? 'rgba(95,70,40,0.95)' : 'rgba(150,130,90,0.85)');
        size = 0.07 + Math.random() * 0.12;
        p.vx = (Math.random() - 0.5) * 2;
        p.vy = Math.random() * 1.5;
        p.gravity = -9;
        p.max = 0.45 + Math.random() * 0.3;
        break;
      case 'spark':
        s.texture = soft(Math.random() < 0.6 ? 'rgba(255,200,80,1)' : 'rgba(255,250,210,1)');
        size = 0.05 + Math.random() * 0.07;
        p.vx = (Math.random() - 0.5) * 6;
        p.vy = Math.random() * 4;
        p.gravity = -10;
        p.max = 0.3 + Math.random() * 0.25;
        break;
      case 'chip':
        s.texture = soft('rgba(225,225,225,0.95)');
        size = 0.08 + Math.random() * 0.1;
        p.vx = (Math.random() - 0.5) * 3;
        p.vy = Math.random() * 2.5;
        p.gravity = -9;
        p.spin = (Math.random() - 0.5) * 10;
        p.max = 0.6;
        break;
      case 'smoke':
        s.texture = soft('rgba(225,225,225,0.45)');
        size = 0.4 + Math.random() * 0.4;
        p.vx = (Math.random() - 0.5) * 0.6;
        p.vy = 0.4 + Math.random() * 0.5;
        p.max = 1.2 + Math.random() * 0.6;
        p.grow = 1.4;
        break;
    }
    p.size = size;
    s.position.set(x, y);
    s.width = s.height = size;
    this.view.addChild(s);
    this.ps.push(p);
  }

  update(dt: number): void {
    for (const [, l] of this.loops) {
      const at = l.at();
      if (!at) continue;
      l.acc += dt * l.rate;
      const aim = l.aim?.() ?? null;
      const jitter = STREAM.has(l.kind) ? 0.06 : 0.4;
      while (l.acc >= 1) {
        l.acc -= 1;
        this.spawn(l.kind, at.x + (Math.random() - 0.5) * jitter, at.y + (Math.random() - 0.5) * jitter, aim, l.tint);
      }
    }
    for (let i = this.ps.length - 1; i >= 0; i--) {
      const p = this.ps[i];
      p.life += dt;
      const k = p.life / p.max;
      if (k >= 1) {
        p.s.removeFromParent();
        this.pool.push(p.s);
        this.ps.splice(i, 1);
        continue;
      }
      p.vy += p.gravity * dt;
      p.s.x += p.vx * dt;
      p.s.y += p.vy * dt;
      p.s.rotation += p.spin * dt;
      const sz = Math.max(0.01, p.size * (1 + p.grow * k));
      p.s.width = p.s.height = sz;
      p.s.alpha = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85;
    }
  }
}

/** The pointing hand shown when the player has not touched anything for a while. */
export class HandHint {
  readonly view = new Container();
  private hand = new Sprite(Texture.EMPTY);
  private t = 0;
  private path: { from: Point; to: Point | null } | null = null;

  constructor() {
    this.view.addChild(this.hand);
    this.view.visible = false;
    void Assets.load<Texture>(import.meta.env.BASE_URL + 'data/ui/hand.png').then((t) => {
      this.hand.texture = t;
      // the original sprite's pivot is the fingertip
      this.hand.anchor.set(0.2111, 0.0368);
    });
  }

  /** Show a drag from -> to (world points), or a tap at from when to is null. */
  show(from: Point, to: Point | null): void {
    this.path = { from, to };
    this.t = 0;
    this.view.visible = true;
  }

  hide(): void {
    this.view.visible = false;
    this.path = null;
  }

  get shown(): boolean {
    return this.view.visible;
  }

  /** px per world unit, so the hand keeps a constant screen size. */
  update(dt: number, unitPx: number): void {
    if (!this.path) return;
    this.t += dt;
    const size = 70 / unitPx;
    this.hand.scale.set(size / 128, -size / 128);
    const { from, to } = this.path;
    if (to) {
      const cyc = 1.8;
      const k = (this.t % cyc) / cyc;
      const m = Math.min(1, Math.max(0, (k - 0.15) / 0.65));
      const e = m < 0.5 ? 2 * m * m : 1 - (-2 * m + 2) ** 2 / 2;
      this.hand.position.set(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
      this.hand.alpha = k > 0.88 ? (1 - k) / 0.12 : Math.min(1, k / 0.1);
    } else {
      const press = 0.5 + 0.5 * Math.sin(this.t * 7);
      this.hand.position.set(from.x, from.y + press * 0.12);
      this.hand.alpha = 1;
    }
  }
}
