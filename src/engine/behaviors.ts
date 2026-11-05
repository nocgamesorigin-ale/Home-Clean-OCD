// Always-on behaviours of the original MonoBehaviours that are not script steps:
// objects that follow Spine bones, insects walking about, objects that drop in when
// they appear, highlight flashes. Runtime calls update(dt) every frame.
import { Point, Sprite } from 'pixi.js';
import type { Spine } from '@esotericsoftware/spine-pixi-v8';
import type { GO, Scene } from './scene';
import { num, type CompData, type Ref } from './types';

interface BoneLink {
  go: GO;
  spine: Spine;
  bone: string;
  rot: boolean;
}

interface Bug {
  go: GO;
  sp: Spine | null;
  a: Point;
  b: Point;
  speed: number;
  idle: number;
  t: number;
  toB: boolean;
  wait: number;
  /** Cockroach.DoDie: seconds since death (-1 alive), how far and how long it falls */
  dead: number;
  stopped: boolean;
  delay: number;
  dropDist: number;
  dropTime: number;
  y0: number;
}

interface Drop {
  go: GO;
  data: CompData;
  was: boolean;
  /** 0..1 while falling, -1 when resting */
  t: number;
  y1: number;
}

interface Flash {
  s: Sprite;
  t: number;
  dur: number;
}

export class Behaviors {
  private bones: BoneLink[] = [];
  private bugs: Bug[] = [];
  private drops: Drop[] = [];
  private flashes: Flash[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly onDropLanded: (d: CompData, g: GO) => void,
  ) {
    for (const g of scene.gos) {
      // SkeletonUtilityBone (follow mode) and BoneFollower: stick to a Spine bone
      const sub = g.comp('SkeletonUtilityBone');
      if (sub && !num(sub.mode)) {
        const holder = scene.get(sub.hierarchy as Ref);
        const sp = holder?.spine ?? holder?.children.find((c) => c.spine)?.spine;
        if (sp && sub.boneName) this.bones.push({ go: g, spine: sp, bone: sub.boneName as string, rot: !!sub.rotation });
      }
      const bf = g.comp('BoneFollower');
      if (bf) {
        const sp = scene.get(bf.skeletonRenderer as Ref)?.spine;
        if (sp && bf.boneName) this.bones.push({ go: g, spine: sp, bone: bf.boneName as string, rot: !!bf.followBoneRotation });
      }
      // insects that walk / fly between two points until they are dealt with
      const bug = g.comp('Cockroach') ?? g.comp('Flies') ?? g.comp('BeeBehavior');
      if (bug) {
        const p1 = scene.get(bug.m_MovePos1 as Ref);
        const p2 = scene.get(bug.m_MovePos2 as Ref);
        const anim = scene.get((bug.m_AnimCockRoach ?? bug.m_Animation ?? bug.m_AnimBee) as Ref);
        if (p1 && p2)
          this.bugs.push({
            go: g, sp: anim?.spine ?? null, a: p1.worldPos(), b: p2.worldPos(), speed: num(bug.m_MoveSpeed, 0.3) * 3, idle: num(bug.m_IdleTime, 3), t: 0, toB: true, wait: Math.random() * 1.5,
            dead: -1, stopped: false, delay: num(bug.m_DelayTimeB4Drop, 0.3), dropDist: num(bug.m_DistanceDrop, 10), dropTime: num(bug.m_TimeDrop, 2), y0: 0,
          });
      }
      const dd = g.comp('DropDownObject');
      if (dd && dd.m_DropOnEnabled) this.drops.push({ go: g, data: dd, was: g.activeInHierarchy, t: -1, y1: g.view.position.y });
    }
  }

  private bugOf(g: GO): Bug | undefined {
    return this.bugs.find((b) => b.go === g);
  }

  /** Cockroach / Flies / BeeBehavior.DoDie: stop, turn over, fall off and fade. */
  kill(g: GO): boolean {
    const b = this.bugOf(g);
    if (!b) return false;
    if (b.dead >= 0) return true;
    b.dead = 0;
    b.y0 = b.go.view.position.y;
    // turned over on its back
    b.go.view.scale.y *= -1;
    const sp = b.sp;
    if (sp) {
      const die = sp.skeleton.data.animations.find((a) => /die|dead|death/i.test(a.name));
      if (die) sp.state.setAnimation(0, die.name, false);
      else sp.state.timeScale = 0;
    }
    return true;
  }

  /** Cockroach.DoStop: freeze where it is. */
  stop(g: GO): void {
    const b = this.bugOf(g);
    if (b) b.stopped = true;
  }

  /** A short additive flash over sprites (EnableOutlineSprite: "use me next"). */
  flash(gos: GO[], dur = 2): void {
    for (const g of gos) {
      if (!g.sprite || !g.activeInHierarchy) continue;
      const s = new Sprite(g.sprite.texture);
      s.anchor.copyFrom(g.sprite.anchor);
      s.scale.copyFrom(g.sprite.scale);
      s.blendMode = 'add';
      s.alpha = 0;
      g.view.addChild(s);
      this.scene.layer.attach(s);
      s.zIndex = g.sortKey + 1;
      this.flashes.push({ s, t: 0, dur });
    }
  }

  update(dt: number): void {
    const world = this.scene.world;
    for (const l of this.bones) {
      if (!l.go.activeInHierarchy) continue;
      const bone = l.spine.skeleton.findBone(l.bone);
      if (!bone || !l.go.view.parent) continue;
      // converts in place, to Pixi global coordinates
      const g = { x: bone.worldX, y: bone.worldY };
      l.spine.skeletonToPixiWorldCoordinates(g);
      const p = l.go.view.parent.toLocal(new Point(g.x, g.y));
      l.go.view.position.set(p.x, p.y);
      if (l.rot) {
        const pm = world.worldTransform.clone().invert().append(l.go.view.parent.worldTransform);
        const parentAngle = Math.atan2(pm.b, pm.a);
        const sm = world.worldTransform.clone().invert().append(l.spine.worldTransform);
        // spine's container is flipped (y-down skeleton in a y-up world)
        const flip = sm.d > 0 ? 1 : -1;
        l.go.view.rotation = (flip * bone.getWorldRotationX() * Math.PI) / 180 + Math.atan2(sm.b, sm.a) - parentAngle;
      }
    }
    for (const b of this.bugs) {
      if (b.dead >= 0) {
        if (!b.go.activeInHierarchy) continue;
        b.dead += dt;
        const k = Math.max(0, b.dead - b.delay) / Math.max(0.3, b.dropTime);
        // drop out of the picture
        b.go.view.position.y = b.y0 - b.dropDist * k * k;
        b.go.view.alpha = Math.max(0, 1 - k * 1.2);
        if (k >= 1) b.go.setActive(false);
        continue;
      }
      if (b.stopped || !b.go.activeInHierarchy || b.go.view.alpha < 1) continue;
      if (b.wait > 0) {
        b.wait -= dt;
        continue;
      }
      const from = b.toB ? b.a : b.b;
      const to = b.toB ? b.b : b.a;
      const d = Math.max(0.01, Math.hypot(to.x - from.x, to.y - from.y));
      b.t = Math.min(1, b.t + (dt * b.speed) / d);
      b.go.setWorldPos(from.x + (to.x - from.x) * b.t, from.y + (to.y - from.y) * b.t);
      const sx = Math.abs(b.go.view.scale.x) * (to.x < from.x ? -1 : 1);
      b.go.view.scale.x = sx;
      if (b.t >= 1) {
        b.t = 0;
        b.toB = !b.toB;
        b.wait = b.idle * (0.5 + Math.random());
      }
    }
    for (const d of this.drops) {
      const on = d.go.activeInHierarchy;
      if (on && !d.was) {
        d.y1 = d.go.view.position.y;
        d.t = 0;
      }
      d.was = on;
      if (d.t >= 0) {
        d.t = Math.min(1, d.t + dt / 0.45);
        d.go.view.position.y = d.y1 + 6 * (1 - d.t * d.t);
        if (d.t >= 1) {
          d.t = -1;
          d.go.view.position.y = d.y1;
          this.onDropLanded(d.data, d.go);
        }
      }
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      f.s.alpha = 0.45 * Math.max(0, Math.sin((f.t / 0.6) * Math.PI)) ** 2;
      if (f.t >= f.dur) {
        f.s.destroy();
        this.flashes.splice(i, 1);
      }
    }
  }
}
