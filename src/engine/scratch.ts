// ScratchCardManager: a surface sprite revealed (mode 1, "fill") or erased (mode 0)
// by a brush. The look is a RenderTexture mask on the surface sprite; the progress
// is a coarse grid of the surface's opaque pixels.
import { Assets, Container, Point, RenderTexture, Sprite, Texture, type Renderer } from 'pixi.js';
import type { GO } from './scene';
import { num, type CompData } from './types';

const GRID = 32;
/** the original soap foam picture, tiled over soap layers that only carry the object's shape */
export const FOAM_KEY = 'soap_bubble_body__58e711c0';
/** foam tile size in world units */
const FOAM_TILE = 2.2;

/** A copy of `shape` filled with tiled foam (the shape's alpha kept). */
function foamFill(shape: Texture, unitsPerPx: number): Texture | null {
  const foam = Assets.get<Texture>('s:' + FOAM_KEY);
  const src = shape.source.resource as CanvasImageSource | undefined;
  const fsrc = foam?.source.resource as CanvasImageSource | undefined;
  if (!foam || !src || !fsrc) return null;
  const w = Math.round(shape.frame.width);
  const h = Math.round(shape.frame.height);
  const tile = Math.max(16, Math.round(FOAM_TILE / Math.max(1e-4, unitsPerPx)));
  const tc = document.createElement('canvas');
  tc.width = tile;
  tc.height = Math.round((tile * foam.frame.height) / foam.frame.width);
  tc.getContext('2d')!.drawImage(fsrc, foam.frame.x, foam.frame.y, foam.frame.width, foam.frame.height, 0, 0, tc.width, tc.height);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  // a soft white base hides the seams between foam tiles; two offset passes break the grid
  g.fillStyle = 'rgba(238, 243, 247, 0.9)';
  g.fillRect(0, 0, w, h);
  const pat = g.createPattern(tc, 'repeat')!;
  g.fillStyle = pat;
  g.fillRect(0, 0, w, h);
  pat.setTransform(new DOMMatrix().translate(tc.width / 2, tc.height / 2));
  g.globalAlpha = 0.7;
  g.fillRect(0, 0, w, h);
  g.globalAlpha = 1;
  // keep only where the object is
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(src, shape.frame.x, shape.frame.y, shape.frame.width, shape.frame.height, 0, 0, w, h);
  return Texture.from(c);
}
let brushTex: Texture | null = null;

function brush(): Texture {
  if (brushTex) return brushTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  brushTex = Texture.from(c);
  return brushTex;
}

export class ScratchCard {
  mode: number;
  private rt: RenderTexture | null = null;
  private maskSprite: Sprite | null = null;
  private stamp = new Sprite(brush());
  /** the blend mode of the root of a render call is ignored: the stamp sits in a container */
  private stampRoot = new Container();
  private opaque = new Uint8Array(GRID * GRID);
  private painted = new Uint8Array(GRID * GRID);
  private total = 1;
  private count = 0;
  private texW = 1;
  private texH = 1;

  constructor(
    readonly go: GO,
    readonly data: CompData,
    readonly surface: GO | undefined,
    private readonly renderer: Renderer,
  ) {
    this.mode = num(data.Mode);
    this.stamp.anchor.set(0.5);
    this.stampRoot.addChild(this.stamp);
    this.setup();
  }

  private setup(): void {
    const s = this.surface?.sprite;
    if (!s) return;
    // a soap layer whose picture is just the dirty object: Unity draws it as foam
    const pic = (this.surface?.comp('SpriteRenderer')?.sprite as string | undefined) ?? '';
    if (this.mode === 1 && /soap/i.test(this.go.name) && !/soap|bubble|foam|froam|xa_phong|xi_ph/i.test(pic)) {
      const t = foamFill(s.texture, Math.abs(s.scale.x));
      if (t) s.texture = t;
    }
    const tex = s.texture;
    this.texW = tex.width;
    this.texH = tex.height;
    // half resolution is plenty for a soft mask
    this.rt = RenderTexture.create({ width: Math.ceil(this.texW / 2), height: Math.ceil(this.texH / 2) });
    const m = new Sprite(this.rt);
    m.anchor.copyFrom(s.anchor);
    m.scale.set(s.scale.x * 2, s.scale.y * 2);
    this.surface!.view.addChild(m);
    this.maskSprite = m;
    if (this.mode === 0) this.fill(1);
    s.setMask({ mask: m });
    this.sampleOpaque(tex);
  }

  private fill(a: number): void {
    if (!this.rt) return;
    const full = new Sprite(Texture.WHITE);
    full.width = this.rt.width;
    full.height = this.rt.height;
    full.alpha = a;
    this.renderer.render({ container: full, target: this.rt, clear: true });
  }

  private sampleOpaque(tex: Texture): void {
    const res = tex.source.resource as CanvasImageSource | undefined;
    const c = document.createElement('canvas');
    c.width = c.height = GRID;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    try {
      if (res) g.drawImage(res, tex.frame.x, tex.frame.y, tex.frame.width, tex.frame.height, 0, 0, GRID, GRID);
      const d = g.getImageData(0, 0, GRID, GRID).data;
      let n = 0;
      for (let i = 0; i < GRID * GRID; i++) {
        this.opaque[i] = d[i * 4 + 3] > 40 ? 1 : 0;
        n += this.opaque[i];
      }
      this.total = Math.max(1, n);
    } catch {
      this.opaque.fill(1);
      this.total = GRID * GRID;
    }
  }

  /** Fraction of the surface already filled (mode 1) or erased (mode 0). */
  get progress(): number {
    return this.count / this.total;
  }

  /** Brush at a world-space point with a radius in world units. */
  /** Returns true when the brush touched the surface. */
  scratchAt(world: Point, worldRadius: number, worldToGlobal: (p: Point) => Point): boolean {
    const s = this.surface?.sprite;
    if (!s || !this.rt || !this.go.selfActive) return false;
    const local = s.toLocal(worldToGlobal(world));
    const edge = s.toLocal(worldToGlobal(new Point(world.x + worldRadius, world.y)));
    const rPx = Math.max(4, Math.hypot(edge.x - local.x, edge.y - local.y));
    const px = local.x + s.anchor.x * this.texW;
    const py = local.y + s.anchor.y * this.texH;
    if (px < -rPx || py < -rPx || px > this.texW + rPx || py > this.texH + rPx) return false;
    this.stamp.position.set(px / 2, py / 2);
    this.stamp.width = this.stamp.height = rPx;
    this.stamp.blendMode = this.mode === 0 ? 'erase' : 'normal';
    this.renderer.render({ container: this.stampRoot, target: this.rt, clear: false });
    // progress grid
    const gx = (px / this.texW) * GRID;
    const gy = (py / this.texH) * GRID;
    // the stamp is rPx wide in the half-size mask = a radius of rPx texture pixels
    const gr = (rPx / this.texW) * GRID + 0.5;
    const gry = (rPx / this.texH) * GRID + 0.5;
    for (let j = Math.max(0, Math.floor(gy - gry)); j <= Math.min(GRID - 1, Math.ceil(gy + gry)); j++)
      for (let i = Math.max(0, Math.floor(gx - gr)); i <= Math.min(GRID - 1, Math.ceil(gx + gr)); i++) {
        const k = j * GRID + i;
        if (!this.opaque[k] || this.painted[k]) continue;
        if (((i + 0.5 - gx) / gr) ** 2 + ((j + 0.5 - gy) / gry) ** 2 > 1) continue;
        this.painted[k] = 1;
        this.count++;
      }
    return true;
  }

  /** A stroke from a to b: stamps along the segment so a fast swipe leaves no gaps. */
  scratchLine(a: Point, b: Point, worldRadius: number, worldToGlobal: (p: Point) => Point): boolean {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.min(40, Math.max(1, Math.ceil(d / (worldRadius * 0.3))));
    let hit = false;
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      hit = this.scratchAt(new Point(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k), worldRadius, worldToGlobal) || hit;
    }
    return hit;
  }

  /** World points of the biggest patches still to do (the "last bits" markers). */
  remaining(max = 4): Point[] {
    const s = this.surface?.sprite;
    if (!s || !this.go.selfActive || this.count >= this.total) return [];
    // group the cells left into 4x4 blocks; the fullest blocks are the patches to show
    const B = 4;
    const blocks: { n: number; x: number; y: number }[] = [];
    for (let bj = 0; bj < GRID / B; bj++)
      for (let bi = 0; bi < GRID / B; bi++) {
        let n = 0, x = 0, y = 0;
        for (let j = bj * B; j < bj * B + B; j++)
          for (let i = bi * B; i < bi * B + B; i++) {
            const k = j * GRID + i;
            if (!this.opaque[k] || this.painted[k]) continue;
            n++;
            x += i + 0.5;
            y += j + 0.5;
          }
        if (n >= 2) blocks.push({ n, x: x / n, y: y / n });
      }
    blocks.sort((p, q) => q.n - p.n);
    const world = this.go.scene.world;
    const out: Point[] = [];
    for (const b of blocks) {
      const lx = (b.x / GRID - s.anchor.x) * this.texW;
      const ly = (b.y / GRID - s.anchor.y) * this.texH;
      const p = world.toLocal(s.toGlobal(new Point(lx, ly)));
      // one marker per area: skip blocks right next to one already shown
      if (out.some((o) => Math.hypot(o.x - p.x, o.y - p.y) < 0.9)) continue;
      out.push(p);
      if (out.length >= max) break;
    }
    return out;
  }

  /** SetScratchCardMode: switch between fill (1) and erase (0); progress counts from now on. */
  setMode(m: number): void {
    if (m === this.mode) return;
    this.mode = m;
    this.painted.fill(0);
    this.count = 0;
  }

  private fadeSprite: Sprite | null = null;
  private fadeRoot = new Container();

  /** One frame of a soft finish: what is left of the job fades by `a` (0..1). */
  fadeRest(a: number): void {
    if (!this.rt) return;
    if (!this.fadeSprite) {
      this.fadeSprite = new Sprite(Texture.WHITE);
      this.fadeRoot.addChild(this.fadeSprite);
    }
    const f = this.fadeSprite;
    f.width = this.rt.width;
    f.height = this.rt.height;
    f.alpha = a;
    f.blendMode = this.mode === 0 ? 'erase' : 'normal';
    this.renderer.render({ container: this.fadeRoot, target: this.rt, clear: false });
  }

  /** Finish the card: fully shown (fill) or fully gone (erase). */
  complete(): void {
    this.fill(this.mode === 0 ? 0 : 1);
    this.count = this.total;
  }

  /** Debug auto-play: world points covering the surface. */
  sweep(): Point[] {
    const s = this.surface?.sprite;
    if (!s) return [];
    const out: Point[] = [];
    const world = this.go.scene.world;
    for (let j = 0; j <= 8; j++)
      for (let i = 0; i <= 8; i++) {
        const lx = (i / 8 - s.anchor.x) * this.texW;
        const ly = (j / 8 - s.anchor.y) * this.texH;
        out.push(world.toLocal(s.toGlobal(new Point(lx, ly))));
      }
    return out;
  }

  /** World-space centre of the surface, for hints and auto-play. */
  centre(): Point | null {
    return this.surface ? this.surface.worldPos() : null;
  }
}
