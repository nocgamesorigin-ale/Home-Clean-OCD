// Builds a Pixi scene from an exported Unity level prefab.
// World units are Unity units (y up). Every renderer is drawn through one RenderLayer
// sorted like Unity's sorting (layer, order, SortingGroup), while its transform and
// visibility still come from the GameObject hierarchy.
import { Assets, Container, MaskFilter, Matrix, NineSliceSprite, Point, RenderLayer, Sprite, Texture, TilingSprite } from 'pixi.js';
import { Spine } from '@esotericsoftware/spine-pixi-v8';
import { isRef, num, type CompData, type LevelData, type NodeData, type Ref, type SpriteMeta } from './types';
import { FOAM_KEY } from './scratch';

const BASE = import.meta.env.BASE_URL + 'data/';

// Pixi draws a sprite-masked object into a texture as big as the object, not cut to the screen
// (MaskFilter turns clipToViewport off). Camera zooms (level transitions zoom right into a point)
// blow that up to 16k px textures and ~600 MB: phones kill the page and it reloads at step 1.
// Only the part on screen is ever seen, so masks are clipped to the screen like other filters.
Object.defineProperty(MaskFilter.prototype, 'clipToViewport', { get: () => true, set: () => {}, configurable: true });

export interface Collider {
  kind: 'box' | 'circle' | 'poly';
  enabled: boolean;
  offset: [number, number];
  size: [number, number];
  radius: number;
  paths: [number, number][][];
}

export class GO {
  readonly children: GO[] = [];
  parent: GO | null = null;
  selfActive: boolean;
  readonly view = new Container();
  sprite: Sprite | null = null;
  spine: Spine | null = null;
  colliders: Collider[] = [];
  sortKey = 0;
  /** Unity sorting order of this renderer (changed by ReduceLayer). */
  order = 0;
  layer = 0;
  baseAlpha = 1;

  constructor(
    readonly id: number,
    readonly data: NodeData,
  ) {
    this.selfActive = data.active;
    this.view.label = data.name;
    // Full Unity transform projected on the XY plane: a Y rotation of 180° mirrors the
    // object, X/Y tilts squash it, so the 2D matrix comes from the rotated axes.
    const [qx, qy, qz, qw] = data.q;
    const [sx, sy] = data.scale;
    const ax = rotate(qx, qy, qz, qw, sx, 0, 0);
    const ay = rotate(qx, qy, qz, qw, 0, sy, 0);
    this.view.setFromMatrix(new Matrix(ax[0], ax[1], ay[0], ay[1], data.pos[0], data.pos[1]));
    this.view.visible = data.active;
  }

  get name(): string {
    return this.data.name;
  }

  get activeInHierarchy(): boolean {
    let g: GO | null = this;
    while (g) {
      if (!g.selfActive) return false;
      g = g.parent;
    }
    return true;
  }

  setActive(on: boolean): void {
    this.selfActive = on;
    this.view.visible = on;
  }

  comp(t: string): CompData | undefined {
    return this.data.comps.find((c): c is CompData => !!c && c.t === t);
  }

  comps(): CompData[] {
    return this.data.comps.filter((c): c is CompData => !!c);
  }

  /** World position of this GameObject (Unity units). */
  worldPos(): Point {
    return this.scene.world.toLocal(this.view.getGlobalPosition(new Point(), false));
  }

  setWorldPos(x: number, y: number): void {
    const p = this.view.parent!.toLocal(this.scene.world.toGlobal(new Point(x, y)));
    this.view.position.set(p.x, p.y);
  }

  scene!: Scene;
}

export class Scene {
  readonly root = new Container();
  /** y-up world in Unity units; the camera moves and scales it. */
  readonly world = new Container();
  readonly layer = new RenderLayer({ sortableChildren: true });
  readonly gos: GO[] = [];
  camX = 0;
  camY = 0;
  camSize = 6;
  private sortLayerIndex = new Map<number, number>();

  constructor(
    readonly level: LevelData,
    sortingLayers: { id: number }[],
  ) {
    sortingLayers.forEach((l, i) => this.sortLayerIndex.set(l.id >>> 0, i));
    this.root.addChild(this.world, this.layer);
  }

  get(r: Ref | null | undefined): GO | undefined {
    return r ? this.gos[r.go] : undefined;
  }

  compOf(r: Ref | null | undefined): CompData | undefined {
    if (!r || r.comp === undefined) return undefined;
    return this.gos[r.go]?.data.comps[r.comp] ?? undefined;
  }

  find(name: string): GO | undefined {
    return this.gos.find((g) => g.name === name);
  }

  async build(spriteMeta: Record<string, SpriteMeta>, spineMeta: Record<string, { scale: number }>, onProgress?: (f: number) => void): Promise<void> {
    const nodes = this.level.nodes;
    // load every texture and skeleton the level uses
    const spriteKeys = new Set<string>();
    const skeletons = new Set<string>();
    for (const n of nodes)
      for (const c of n.comps) {
        if (!c) continue;
        if ((c.t === 'SpriteRenderer' || c.t === 'SpriteMask') && typeof c.sprite === 'string') spriteKeys.add(c.sprite);
        // UI pictures and tool thumbnails (m_Sprite, m_ImgThumbnail, m_OverrideSprite, ...)
        for (const v of Object.values(c)) {
          const sp = (v as { sprite?: unknown } | null)?.sprite;
          if (v && typeof v === 'object' && typeof sp === 'string') spriteKeys.add(sp);
        }
        const sk = c.skeletonDataAsset as { skeleton?: string } | undefined;
        if (c.t === 'SkeletonAnimation' && sk?.skeleton) skeletons.add(sk.skeleton);
      }
    // soap layers are filled with the original foam picture
    if (nodes.some((n) => n.comps.some((c) => c?.t === 'ScratchCardManager'))) spriteKeys.add(FOAM_KEY);
    const jobs: Promise<unknown>[] = [];
    for (const k of spriteKeys) if (spriteMeta[k]) jobs.push(Assets.load({ alias: 's:' + k, src: `${BASE}sprites/${k}.webp` }));
    for (const k of skeletons)
      jobs.push(
        Assets.load([
          { alias: 'k:' + k, src: `${BASE}spine/${k}.skel` },
          { alias: 'a:' + k, src: `${BASE}spine/${k}.atlas` },
        ]),
      );
    let settled = 0;
    await Promise.allSettled(jobs.map((j) => j.finally(() => onProgress?.(++settled / jobs.length))));

    nodes.forEach((n, i) => {
      const g = new GO(i, n);
      g.scene = this;
      this.gos.push(g);
    });
    for (const g of this.gos) {
      const p = g.data.parent >= 0 ? this.gos[g.data.parent] : null;
      g.parent = p;
      if (p) {
        p.children.push(g);
        p.view.addChild(g.view);
      } else this.world.addChild(g.view);
    }
    for (const g of this.gos) this.buildRenderers(g, spriteMeta, spineMeta);
    this.resort();
    this.applyMasks();
  }

  private buildRenderers(g: GO, spriteMeta: Record<string, SpriteMeta>, spineMeta: Record<string, { scale: number }>): void {
    for (const c of g.comps()) {
      if (c.t === 'BoxCollider2D' || c.t === 'BoxCollider') {
        const off = (c.offset as [number, number]) ?? [0, 0];
        const size = (c.size as [number, number]) ?? [1, 1];
        g.colliders.push({ kind: 'box', enabled: c.enabled !== false, offset: off, size, radius: 0, paths: [] });
      } else if (c.t === 'CircleCollider2D') {
        g.colliders.push({ kind: 'circle', enabled: c.enabled !== false, offset: c.offset as [number, number], size: [0, 0], radius: num(c.radius, 0.5), paths: [] });
      } else if (c.t === 'PolygonCollider2D') {
        g.colliders.push({ kind: 'poly', enabled: c.enabled !== false, offset: c.offset as [number, number], size: [0, 0], radius: 0, paths: c.paths as [number, number][][] });
      }
    }
    const sr = g.comp('SpriteRenderer');
    if (sr && typeof sr.sprite === 'string' && spriteMeta[sr.sprite]) {
      const m = spriteMeta[sr.sprite];
      const tex = Assets.get<Texture>('s:' + sr.sprite) ?? Texture.EMPTY;
      const flip = (sr.flip as boolean[]) ?? [false, false];
      const fx = flip[0] ? -1 : 1;
      const fy = flip[1] ? -1 : 1;
      // texture pixels per world unit
      const tpx = Math.max(1, m.iw) / (m.w / m.ppu);
      const tpy = Math.max(1, m.ih) / (m.h / m.ppu);
      const mode = num(sr.drawMode);
      const size = sr.size as [number, number] | undefined;
      let s: Sprite;
      if (mode !== 0 && size) {
        // Unity border: left, bottom, right, top in sprite pixels
        const [bl, bb, br, bt] = (m.border ?? [0, 0, 0, 0]).map((v, i) => v * (i % 2 ? m.ih / m.h : m.iw / m.w));
        const bordered = bl + bb + br + bt > 0;
        const opts = { texture: tex, width: size[0] * tpx, height: size[1] * tpy };
        // Sliced (and Tiled with borders): fixed corners, stretched middle; Tiled: repeat
        const v = mode === 1 || bordered ? new NineSliceSprite({ ...opts, leftWidth: bl, topHeight: bt, rightWidth: br, bottomHeight: bb }) : new TilingSprite(opts);
        s = v as unknown as Sprite;
      } else s = new Sprite(tex);
      s.anchor.set(m.pivot[0], 1 - m.pivot[1]);
      s.scale.set(fx / tpx, -fy / tpy);
      const col = (sr.color as number[]) ?? [1, 1, 1, 1];
      s.tint = ((Math.round(col[0] * 255) << 16) | (Math.round(col[1] * 255) << 8) | Math.round(col[2] * 255)) >>> 0;
      s.alpha = col[3];
      g.baseAlpha = col[3];
      s.renderable = sr.enabled !== false;
      g.sprite = s;
      g.order = num(sr.order);
      g.layer = num(sr.layer);
      g.view.addChild(s);
      this.layer.attach(s);
    }
    const sa = g.comp('SkeletonAnimation');
    const sk = sa?.skeletonDataAsset as { skeleton?: string } | undefined;
    if (sa && sk?.skeleton && Assets.get('k:' + sk.skeleton)) {
      try {
        const sp = Spine.from({ skeleton: 'k:' + sk.skeleton, atlas: 'a:' + sk.skeleton, scale: spineMeta[sk.skeleton]?.scale ?? 0.01, autoUpdate: false });
        sp.scale.y = -1;
        const skin = sa.initialSkinName as string;
        if (skin) {
          try {
            sp.skeleton.setSkinByName(skin);
            sp.skeleton.setSlotsToSetupPose();
          } catch {
            /* skin missing */
          }
        }
        const anim = sa._animationName as string;
        if (anim && sp.skeleton.data.findAnimation(anim)) sp.state.setAnimation(0, anim, !!sa.loop);
        else if ('err' in sa) {
          // the export lost this component's settings: start on the idle the script uses for it
          const used = this.animsUsedOn(g.id);
          const names = sp.skeleton.data.animations.map((a) => a.name);
          const pick = used.find((a) => /idle/i.test(a) && names.includes(a)) ?? names.find((a) => /idle/i.test(a)) ?? used.find((a) => names.includes(a)) ?? names[0];
          if (!sp.skeleton.skin && sp.skeleton.data.skins.length > 1 && !sp.skeleton.data.defaultSkin?.attachments.some((x) => x && Object.keys(x).length)) {
            sp.skeleton.setSkin(sp.skeleton.data.skins[1]);
            sp.skeleton.setSlotsToSetupPose();
          }
          if (pick) {
            const tr = sp.state.setAnimation(0, pick, true);
            // not an idle: hold its first frame until the script plays something
            if (!/idle/i.test(pick)) tr.timeScale = 0;
          }
        }
        sp.state.timeScale = num(sa.timeScale, 1);
        const mr = g.comp('MeshRenderer');
        g.order = num(mr?.order);
        g.layer = num(mr?.layer);
        g.spine = sp;
        g.view.addChild(sp);
        this.layer.attach(sp);
      } catch (e) {
        console.warn('spine', sk.skeleton, e);
      }
    }
  }

  private animUse: Map<number, string[]> | null = null;

  /** Animation names the level's scripts play on a SkeletonAnimation GameObject. */
  animsUsedOn(id: number): string[] {
    if (!this.animUse) {
      const m = new Map<number, string[]>();
      const add = (r: unknown, name: unknown) => {
        const go = (r as { go?: number } | null)?.go;
        if (typeof go !== 'number' || typeof name !== 'string' || !name) return;
        const l = m.get(go) ?? [];
        if (!l.includes(name)) l.push(name);
        m.set(go, l);
      };
      for (const n of this.level.nodes)
        for (const c of n.comps) {
          if (!c) continue;
          if (c.t === 'RemoteRunAnimation') for (const st of (c.m_ListAnimStep as { name?: string }[]) ?? []) add(c.m_SkeletonAnimation, st?.name);
          if (c.t === 'RunAnimation') for (const r of (c.skeletonAnimation as unknown[]) ?? []) add(r, c.anim_name);
        }
      this.animUse = m;
    }
    return this.animUse.get(id) ?? [];
  }

  /** Sort key for something drawn at a Unity (layer, order), above sprites of the same order. */
  sortKeyFor(layer: number, order: number): number {
    return ((this.sortLayerIndex.get(layer >>> 0) ?? 0) * 1e5 + order + 5e4) * 1e9 + 9e8;
  }

  /** Unity sorting: sorting layer, then order (SortingGroup first), then hierarchy order. */
  resort(): void {
    for (const g of this.gos) {
      const r = g.sprite ?? g.spine;
      if (!r) continue;
      let group: GO | null = null;
      for (let p = g.parent; p; p = p.parent)
        if (p.comp('SortingGroup')) {
          group = p;
          break;
        }
      // renderers store the layer id signed, the TagManager unsigned
      const li = (lid: number) => this.sortLayerIndex.get(lid >>> 0) ?? 0;
      let primary: number;
      let secondary: number;
      if (group) {
        const sg = group.comp('SortingGroup')!;
        primary = li(num(sg.layer)) * 1e5 + num(sg.order) + 5e4;
        secondary = g.order + 5e4;
      } else {
        primary = li(g.layer) * 1e5 + g.order + 5e4;
        secondary = 0;
      }
      g.sortKey = primary * 1e9 + secondary * 1e4 + g.id;
      r.zIndex = g.sortKey;
    }
    this.layer.sortRenderLayerChildren();
  }

  /** SpriteMask: sprites with mask interaction use a mask whose sorting range covers them. */
  applyMasks(): void {
    const masks = this.gos.filter((g) => g.comp('SpriteMask'));
    for (const g of this.gos) {
      const sr = g.comp('SpriteRenderer');
      const mi = num(sr?.mask);
      if (!g.sprite || !mi) continue;
      const m = masks.find((mg) => {
        const sm = mg.comp('SpriteMask')!;
        return g.order > num(sm.back) && g.order <= num(sm.front) && sameBranch(mg, g);
      }) ?? masks.find((mg) => sameBranch(mg, g));
      if (!m) continue;
      const ms = this.maskSprite(m);
      if (ms) g.sprite.setMask({ mask: ms, inverse: mi === 2 });
    }
  }

  private maskCache = new Map<number, Sprite>();
  maskSprite(g: GO): Sprite | null {
    const hit = this.maskCache.get(g.id);
    if (hit) return hit;
    const sm = g.comp('SpriteMask');
    if (!sm || typeof sm.sprite !== 'string') return null;
    const tex = Assets.get<Texture>('s:' + sm.sprite);
    if (!tex) return null;
    const s = new Sprite(tex);
    const meta = this.spriteMetaOf?.(sm.sprite);
    if (meta) {
      s.anchor.set(meta.pivot[0], 1 - meta.pivot[1]);
      s.scale.set(meta.w / meta.ppu / meta.iw, -(meta.h / meta.ppu / meta.ih));
    }
    g.view.addChild(s);
    this.maskCache.set(g.id, s);
    return s;
  }

  spriteMetaOf?: (k: string) => SpriteMeta | undefined;

  // ---- camera -------------------------------------------------------------

  /** The original was laid out for 640x1136 portrait: keep that width in view on taller phones. */
  static readonly DESIGN_ASPECT = 640 / 1136;

  layout(width: number, height: number): void {
    const k = Math.min(height / (this.camSize * 2), width / (this.camSize * 2 * Scene.DESIGN_ASPECT));
    this.world.scale.set(k, -k);
    this.world.position.set(width / 2 - this.camX * k, height / 2 + this.camY * k);
  }

  /** Screen px -> world units. */
  toWorld(x: number, y: number): Point {
    return this.world.toLocal(new Point(x, y));
  }
}

/** Rotate vector v by quaternion q. */
function rotate(qx: number, qy: number, qz: number, qw: number, vx: number, vy: number, vz: number): [number, number, number] {
  // t = 2 * (q.xyz x v); v' = v + w t + q.xyz x t
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}

function sameBranch(a: GO, b: GO): boolean {
  // masks normally sit next to what they mask: share an ancestor below the level root
  const anc = new Set<GO>();
  for (let p: GO | null = a; p; p = p.parent) anc.add(p);
  let depth = 0;
  for (let p: GO | null = b; p; p = p.parent, depth++) if (anc.has(p)) return p.parent !== null || depth < 2;
  return false;
}

export { isRef };
