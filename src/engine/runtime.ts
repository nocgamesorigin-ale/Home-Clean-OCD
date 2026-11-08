// Runs a level's script the way the original TweenSequence system does.
//
// SequenceManager -> TweenSequence children -> TweenStep children, in hierarchy order.
// Inside a step every child GameObject holding an action component is run in order:
//  - ordinary actions start after their m_Delay and do not hold the step;
//  - WaitMs and the interactive tasks (drag, scratch, pluck, choose...) hold the step
//    until they finish.
// A "holder" GameObject (ActionsOnDoneHolder, TweenOnTrigger, a DragColliderTarget...)
// runs its children's actions the same way when its event fires.
import { Assets, Graphics, Point, Rectangle, type Application, type Texture } from 'pixi.js';
import { play, stopLoops, type Voice } from './audio';
import type { GO, Scene } from './scene';
import { ScratchCard } from './scratch';
import { isRef, num, refs, type CompData, type Ref } from './types';
import { autoSolveMatch, ChooserUI, matchPairs, ToolBadge } from './ui';
import { Fx, HandHint, kindOf, type FxKind } from './fx';
import { buildEmitters, withChildren, type Emitter } from './particles';
import { Behaviors } from './behaviors';

type Fn = (dt: number) => boolean | void;

const INTERACTIVE = new Set([
  'ToolTrashCan', 'DragCollider', 'DragObject', 'PluckObject', 'ParallelInteractiveItem', 'DragObjectMultiSlot',
  'DragObjectMultipleSlot_ToolSwap', 'ScratchObject', 'ChooseOption', 'ChooseOptionTool', 'InteractiveMultiTool',
  'DragMultiObjectByDraggableItem', 'DragObjectMulti', 'DragObjectMulti2', 'DragObjectMultiInOrder', 'ClickObject',
  'ClickHold', 'CollectObject', 'SwipeObject', 'HoldToDoStuffObject', 'DragRotateObject', 'ChooseOptionByDraggableObject',
]);

interface Drag {
  item: GO;
  task: Task;
  grab: Point; // offset item - pointer (world)
  start: Point; // item world pos at drag start
  moved: number;
}

interface Task {
  key?: string;
  items: GO[];
  kind?: string;
  /** Debug auto-play: world points the tool should visit. */
  goals?(): Point[];
  /** The spots still to do, marked on screen near the end so the last bits are easy to find. */
  left?(): Point[];
  /** Called while an item is dragged; return true when the task is done. */
  onMove?(item: GO): void;
  /** Called on release; return true when the item was used (no snap back). */
  onRelease?(item: GO): boolean;
  /** Tap tasks: a tap at a world point. */
  onTap?(p: Point): void;
  /** Hold tasks: called every frame while the finger is down (world point). */
  onHold?(dt: number, p: Point): void;
  onHoldEnd?(): void;
  /** An item of this task was picked up. */
  onGrab?(item: GO): void;
  /** Runtime clock when the task started (QA). */
  born?: number;
  /** 0..1, for the tool badge's progress bar. */
  progress?(): number;
  /** Debug auto-play: world points to tap / hold. */
  taps?(): Point[];
  /** Debug auto-play: finish the gesture by itself (pump, screw, wires...). */
  auto?(): void;
  done: boolean;
  finish(): void;
}

type Fn0 = () => void;

export class Runtime {
  time = 0;
  private frames: Fn[] = [];
  private tasks: Task[] = [];
  private drag: Drag | null = null;
  private hold: { task: Task; p: Point } | null = null;
  /** SetActiveCamZone: the player may pan the camera with a free finger. */
  private camZone: { h: boolean; v: boolean } | null = null;
  private pan: { x: number; y: number; cx: number; cy: number } | null = null;
  private voices = new Map<string, Voice>();
  private cards = new Map<string, ScratchCard>();
  readonly ui: ChooserUI;
  stepName = '';
  progress = 0;
  finished = false;
  /** Called for every step start, for the HUD. */
  onStep?: (name: string, index: number, total: number) => void;
  /** A decoration / style was picked (object namecode, option namecode), for the home rooms. */
  onChoice?: (obj: string, option: string) => void;
  /** Step names of the level, and the one being played. */
  stepNames: string[] = [];
  stepIndex = 0;
  /** Cheat: play every step before this index automatically, at high speed. */
  fastForwardTo = -1;
  /** Cheat: let the game play itself. */
  autoPlay = false;

  constructor(
    readonly scene: Scene,
    readonly app: Application,
  ) {
    this.ui = new ChooserUI(app, scene);
    this.badge = new ToolBadge(app);
    for (const v of [this.marks, this.fx.view, this.hint.view]) {
      scene.world.addChild(v);
      scene.layer.attach(v);
      v.zIndex = 1e16 + (v === this.hint.view ? 1 : v === this.marks ? -1 : 0);
    }
    this.spines = scene.gos.filter((g) => g.spine);
    // RandomRotationAtStart / RandomScaleAtStart: every copy (soap foam...) looks a little different
    for (const g of scene.gos) {
      if (g.comp('RandomRotationAtStart')) g.view.rotation = Math.random() * Math.PI * 2;
      const rs = g.comp('RandomScaleAtStart');
      if (rs) {
        const k = num(rs.minScale, 1) + Math.random() * (num(rs.maxScale, 1) - num(rs.minScale, 1));
        g.view.scale.set(g.view.scale.x * k, g.view.scale.y * k);
      }
    }
    this.randomAnims = this.spines.filter((g) => g.comp('RandomAnimationAtStart'));
    this.behaviors = new Behaviors(scene, (d) => {
      const sp = scene.get(d.m_AnimDropDown as Ref);
      if (sp) {
        sp.setActive(true);
        const a = sp.spine?.skeleton.data.animations[0];
        if (a) sp.spine!.state.setAnimation(0, a.name, false);
      }
      const fx = scene.get(d.m_FXDropdown as Ref);
      if (fx) for (const e of withChildren(fx, this.emitters)) e.play();
      play('Item_Drop');
    });
    // TweenOnTriggerAnimEvent: Spine animation events start actions (salt falls on "sprinkle_salt"...)
    for (const g of scene.gos) {
      const te = g.comp('TweenOnTriggerAnimEvent');
      const sp = te ? scene.get(te.m_SkeletonAnimation as Ref)?.spine : undefined;
      if (!te || !sp) continue;
      const models = (te.m_ListTweenModel as { m_EventName: string; m_ListTween: Ref[] }[]) ?? [];
      sp.state.addListener({
        event: (_e, ev) => {
          for (const m of models) if (m.m_EventName === ev.data.name) this.runRefs(m.m_ListTween);
        },
      });
    }
    // progress listeners of scratch tasks
    for (const g of scene.gos)
      for (const c of g.comps()) {
        if (c.t === 'FadeSpriteByScratchProgress' && c.m_ScratchCard) this.fadeByCard.push({ card: key(c.m_ScratchCard as Ref), sprites: this.gosOf(c.m_ListSprite, c.m_Sprite), down: !!c.FADE_DOWN });
        if (c.t === 'FadeSpriteByCookingProgress') this.fadeByCooking.push({ progress: (c.m_Progress as Ref)?.go ?? g.id, sprites: this.gosOf(c.m_ListSpriteRenderer), a0: num(c.m_StartAlpha, 1), a1: num(c.m_EndAlpha, 0) });
      }
    // the original particle systems
    this.emitters = buildEmitters(scene.gos);
    for (const e of this.emitters.values()) {
      scene.world.addChild(e.view);
      scene.layer.attach(e.view);
      const r = e.go.comp('ParticleSystemRenderer');
      e.view.zIndex = scene.sortKeyFor(num(r?.layer), num(r?.order));
    }
    // build every scratch card up front so fill-mode surfaces start hidden
    for (const g of scene.gos) {
      const c = g.comp('ScratchCardManager');
      if (c) this.cards.set(key({ go: g.id, comp: g.data.comps.indexOf(c) }), new ScratchCard(g, c, scene.get(c.SpriteCard as Ref), app.renderer));
    }
  }

  // ---- clock ----------------------------------------------------------------

  private spines: GO[] = [];
  /** Spines that start a random animation of theirs when they appear. */
  private randomAnims: GO[] = [];
  private shownBefore = new Set<GO>();
  readonly fx = new Fx();
  private emitters = new Map<number, Emitter>();
  private behaviors!: Behaviors;
  /** FadeSpriteByScratchProgress: sprites that fade out (down) or in (a towel getting dirty) with a card. */
  private fadeByCard: { card: string; sprites: GO[]; down: boolean }[] = [];
  private fadeByCooking: { progress: number; sprites: GO[]; a0: number; a1: number }[] = [];
  readonly hint = new HandHint();
  /** Pulsing rings on the last spots of a task (see Task.left). */
  private marks = new Graphics();
  private markPts: Point[] = [];
  private markT = 0;
  private markA = 0;
  /** Seconds since the player last touched the screen (drives the hand hint). */
  private idle = 0;

  update(dt: number): void {
    this.time += dt;
    for (const g of this.randomAnims) {
      const on = g.activeInHierarchy;
      if (on && !this.shownBefore.has(g)) {
        const anims = g.spine!.skeleton.data.animations;
        const a = anims[Math.floor(Math.random() * anims.length)];
        if (a) g.spine!.state.setAnimation(0, a.name, false);
      }
      if (on) this.shownBefore.add(g);
      else this.shownBefore.delete(g);
    }
    for (const g of this.spines) if (g.activeInHierarchy) g.spine!.update(dt);
    if (this.hold && !this.hold.task.done) this.hold.task.onHold?.(dt, this.hold.p);
    this.fx.update(dt);
    for (const e of this.emitters.values()) e.update(dt, this.scene.world);
    this.behaviors.update(dt);
    this.updateHint(dt);
    this.updateMarks(dt);
    this.updateBadge();
    if (this.dragVoice && (!this.drag || this.time - this.workedAt > 0.2 || (this.dragFallback && this.time - this.fallbackAt > 0.25))) {
      this.dragVoice.stop(0.12);
      this.dragVoice = null;
    }
    this.updateStepProgress();
    // callbacks may start new sleeps/tweens while they run: those must not be lost
    const cur = this.frames;
    this.frames = [];
    const keep = cur.filter((f) => !f(dt));
    this.frames = keep.concat(this.frames);
    if (this.qaOn && (this.qaT += dt) >= 1) {
      this.qaT = 0;
      this.qaCheck();
    }
  }

  /** How far the current step is (0..1): its tasks done + the one in progress. */
  stepProgress = 0;
  private stepKeys = new Set<string>();
  private stepDoneKeys = new Set<string>();

  private updateStepProgress(): void {
    if (!this.stepKeys.size) return;
    let live = 0;
    for (const t of this.tasks) if (!t.done && t.progress) live = Math.max(live, Math.min(1, t.progress()));
    const p = Math.min(1, (this.stepDoneKeys.size + live) / this.stepKeys.size);
    if (p > this.stepProgress) this.stepProgress = p;
  }

  /** The tool in use and how far its job is. */
  private badge!: ToolBadge;

  private updateBadge(): void {
    if (!this.badge.shown) {
      // a dragged tool with a thumbnail shows itself even without a SetToolUIProgress tween
      const it = this.drag?.item;
      const th = (it?.comps().find((x) => 'm_ImgThumbnail' in x)?.m_ImgThumbnail as { sprite?: string } | undefined)?.sprite;
      if (th && Assets.cache.has('s:' + th)) this.badge.show(Assets.get<Texture>('s:' + th));
      else return;
    }
    const t = this.tasks.find((x) => x.progress);
    if (t) this.badge.set(t.progress!());
  }

  /** QA (auto-test): problems a player would see, collected while the level plays. */
  qaOn = false;
  readonly qa = { missingAnim: new Set<string>(), offscreen: new Set<string>(), leftover: new Set<string>(), noFx: new Set<string>() };
  private qaT = 0;
  private qaTools = new Set<GO>();
  private qaSeen = new Map<GO, { x: number; y: number; t: number }>();

  private qaCheck(): void {
    const k = this.scene.world.scale.x;
    const hw = this.app.screen.width / 2 / k;
    const hh = this.app.screen.height / 2 / k;
    const inView = (g: GO) => {
      const p = g.worldPos();
      return Math.abs(p.x - this.scene.camX) < hw && Math.abs(p.y - this.scene.camY) < hh;
    };
    // a task whose tools never come on screen cannot be played
    for (const t of this.tasks)
      if (t.items.length && this.time - (t.born ?? this.time) > 4 && !t.items.some((i) => i.activeInHierarchy && inView(i)))
        this.qa.offscreen.add(`${this.stepName}: ${t.kind} ${t.items.map((i) => i.name).join(',')}`);
    // tools that return to base, done with, still standing in the picture
    const busy = new Set(this.tasks.flatMap((t) => t.items));
    for (const g of this.qaTools) {
      const di = g.comp('DraggableItem');
      if (!di?.snapToBasePos || busy.has(g) || !g.activeInHierarchy || !inView(g) || this.drag?.item === g) {
        this.qaSeen.delete(g);
        continue;
      }
      const p = g.worldPos();
      const s0 = this.qaSeen.get(g);
      if (!s0 || Math.hypot(s0.x - p.x, s0.y - p.y) > 0.05) this.qaSeen.set(g, { x: p.x, y: p.y, t: this.time });
      else if (this.time - s0.t > 5) this.qa.leftover.add(`${this.stepName}: ${g.name}`);
    }
  }

  private every(f: Fn): void {
    this.frames.push(f);
  }

  sleep(sec: number): Promise<void> {
    if (sec <= 0) return Promise.resolve();
    return new Promise((res) => {
      let t = 0;
      this.every((dt) => {
        t += dt;
        if (t >= sec) {
          res();
          return true;
        }
      });
    });
  }

  tween(sec: number, f: (k: number) => void): Promise<void> {
    return new Promise((res) => {
      if (sec <= 0) {
        f(1);
        res();
        return;
      }
      let t = 0;
      this.every((dt) => {
        t = Math.min(sec, t + dt);
        f(easeInOut(t / sec));
        if (t >= sec) {
          res();
          return true;
        }
      });
    });
  }

  // ---- script -----------------------------------------------------------------

  /** Plays the level's steps; `seq` picks another sequence holder (a room's SequenceManagerOverview). */
  async run(seq?: GO): Promise<void> {
    const sm = seq ?? this.scene.gos.find((g) => g.comp('SequenceManager'));
    if (!sm) return;
    const steps: GO[] = [];
    for (const seq of sm.children) if (seq.comp('TweenSequence') && seq.selfActive) for (const st of seq.children) if (st.comp('TweenStep') && st.selfActive) steps.push(st);
    this.stepNames = steps.map((s) => s.name);
    for (let i = 0; i < steps.length; i++) {
      this.stepIndex = i;
      this.stepName = steps[i].name;
      this.progress = i / steps.length;
      this.onStep?.(steps[i].name, i, steps.length);
      // the step's own interactive tasks, for its progress bar
      this.stepKeys = new Set(steps[i].children.filter((o) => o.selfActive).flatMap((o) => o.comps().filter((c) => c.m_Enabled !== 0 && isTask(c)).map((c) => key({ go: o.id, comp: o.data.comps.indexOf(c) }))));
      this.stepDoneKeys = new Set();
      this.stepProgress = this.stepKeys.size ? 0 : 1;
      const before = this.visualState();
      // QA: anything seen changing while the step runs (a drop-in that lands back counts)
      const seen = new Set<number>();
      let sampleT = 0;
      let stepDone = false;
      this.every((dt) => {
        if ((sampleT += dt) >= 0.2) {
          sampleT = 0;
          for (const k of this.diffIds(before, false)) seen.add(k);
        }
        return stepDone;
      });
      await this.runList(steps[i].children);
      this.stepProgress = 1;
      await this.sleep(0.6);
      stepDone = true;
      for (const k of this.diffIds(before, true)) seen.add(k);
      this.stepChanges.push({ step: steps[i].name, changed: seen.size });
      this.dropTasks();
      this.badge.hide();
      // the step's job is done: no loop (soap, spray, motor...) keeps playing over the next one
      stopLoops(0.25);
      this.voices.clear();
      this.dragVoice = null;
    }
    this.progress = 1;
    this.stopSounds();
    this.fx.stopAll();
    this.fx.burst('sparkle', this.scene.camX, this.scene.camY, 40, this.scene.camSize * 1.2);
    play('Success_Long');
    this.finished = true;
  }

  /** Run the actions found on a list of GameObjects (a step or a holder's children). */
  async runList(list: GO[]): Promise<void> {
    for (const g of list) {
      if (!g.selfActive) continue;
      for (const c of g.comps()) {
        if (c.m_Enabled === 0) continue;
        if (c.t === 'WaitMs') {
          await this.sleep(num(c.m_Delay) + num(c.m_Time));
        } else if (isTask(c)) {
          await this.sleep(num(c.m_Delay));
          await this.interactive(g, c);
        } else if ('m_TweenChecker' in c) {
          const d = num(c.m_Delay);
          if (d > 0) void this.sleep(d).then(() => this.action(g, c));
          else void this.action(g, c);
        }
      }
    }
  }

  /** Run actions named by component references (lists of tweens). */
  runRefs(list: unknown): void {
    for (const r of refs(list)) {
      const g = this.scene.get(r);
      const c = this.scene.compOf(r);
      if (g && c) void this.action(g, c);
      else if (g) void this.runList([g]);
    }
  }

  runHolder(r: unknown): Promise<void> {
    const g = isRef(r) ? this.scene.get(r) : undefined;
    return g ? this.runList(g.children) : Promise.resolve();
  }

  private gosOf(...vals: unknown[]): GO[] {
    const out: GO[] = [];
    for (const v of vals) for (const r of refs(v)) {
      const g = this.scene.get(r);
      if (g) out.push(g);
    }
    return out;
  }

  // ---- actions --------------------------------------------------------------

  async action(g: GO, c: CompData): Promise<void> {
    const T = num(c.m_Time);
    switch (c.t) {
      case 'SetActiveGameObject':
        for (const o of this.gosOf(c.m_GameObj, c.m_ListGameObject)) {
          o.setActive(!!c.m_Active);
          // a task nested in another task (chainsaw + flying leaves) runs once switched on
          if (c.m_Active)
            for (const d of [o, ...descendants(o)])
              if (d.activeInHierarchy && d.parent?.comps().some(isTask))
                for (const cc of d.comps()) if (isTask(cc) && cc.m_Enabled !== 0) void this.interactive(d, cc);
        }
        return;
      case 'SetEnableCollider':
        for (const r of [...refs(c.m_ListCollider), ...refs(c.m_ListBoxCollider), ...refs(c.m_Collider)]) {
          const o = this.scene.get(r);
          if (o) for (const col of o.colliders) col.enabled = !!c.m_Active;
        }
        return;
      case 'SetEnableSprite':
        for (const o of this.gosOf(c.m_ListSprite)) if (o.sprite) o.sprite.renderable = !!c.active;
        return;
      case 'MoveObjectIn': {
        const objs = this.gosOf(c.m_GameObj, c.m_ListGameObject);
        const targets = this.gosOf(c.m_TargetObject, c.m_ListTargetObject);
        await Promise.all(
          objs.map((o, i) => {
            const t = targets[i] ?? targets[0];
            if (!t) return Promise.resolve();
            // like DOTween: moves the object, switched on or not
            return this.moveTo(o, t.worldPos(), T);
          }),
        );
        return;
      }
      case 'MoveAndFaded': {
        const dir = num(c.direction);
        const dist = num(c.m_Distance, 10);
        const [dx, dy] = [[-1, 0], [1, 0], [0, -1], [0, 1]][dir] ?? [1, 0];
        await Promise.all(
          this.gosOf(c.m_GameObj).map(async (o) => {
            const p = o.worldPos();
            const fadeT = num(c.m_FadeTime);
            const sprites = this.gosOf(c.sprite).filter((x) => x.sprite);
            if (fadeT > 0 && sprites.length)
              void this.sleep(Math.max(0, T - fadeT)).then(() => Promise.all(sprites.map((x) => { const a = x.sprite!.alpha; return this.tween(fadeT, (k) => (x.sprite!.alpha = a * (1 - k))); })));
            await this.moveTo(o, new Point(p.x + dx * dist, p.y + dy * dist), T);
            if (c.m_OffColliderWhenDoneMove) o.colliders.forEach((col) => (col.enabled = false));
          }),
        );
        return;
      }
      case 'RotateObject': {
        const to = (num(c.m_Rotation) * Math.PI) / 180;
        await Promise.all(
          this.gosOf(c.m_GameObj, c.m_ListObj).map((o) => {
            const from = o.view.rotation;
            return this.tween(T, (k) => (o.view.rotation = from + (to - from) * k));
          }),
        );
        return;
      }
      case 'ScaleObject': {
        const to = (c.m_Scale ?? c.m_EndScale) as { x: number; y: number } | undefined;
        if (!to) return;
        await Promise.all(
          this.gosOf(c.m_GameObj, c.m_ListObj, c.m_ListGameObject).map((o) => {
            const sx = o.view.scale.x;
            const sy = o.view.scale.y;
            return this.tween(T, (k) => o.view.scale.set(sx + (to.x - sx) * k, sy + (to.y - sy) * k));
          }),
        );
        return;
      }
      case 'FadeSprite':
        await Promise.all(
          this.gosOf(c.m_ListSprite, c.sprite).map((o) => {
            const s = o.sprite;
            if (!s) return Promise.resolve();
            const a = s.alpha;
            const to = num(c.m_TargetFade, 0);
            if (to > 0) this.fadedIn.add(o);
            return this.tween(T, (k) => (s.alpha = a + (to - a) * k));
          }),
        );
        return;
      case 'ReduceLayer':
        for (const o of this.gosOf(c.m_ListSprite, c.m_ListSkeletonAnimation)) o.order = num(c.newLayer);
        this.scene.resort();
        return;
      case 'MoveCamera': {
        const t = this.scene.get(c.m_GameObj as Ref);
        if (!t) return;
        const p = t.worldPos();
        const x0 = this.scene.camX;
        const y0 = this.scene.camY;
        await this.tween(T, (k) => {
          this.scene.camX = x0 + (p.x - x0) * k;
          this.scene.camY = y0 + (p.y - y0) * k;
          this.relayout();
        });
        return;
      }
      case 'ZoomCamera': {
        const s0 = this.scene.camSize;
        // transitions zoom right into a point; past ~1 unit masks would need huge textures
        const s1 = Math.max(2, num(c.m_CameraSize, s0));
        await this.tween(T, (k) => {
          this.scene.camSize = s0 + (s1 - s0) * k;
          this.relayout();
        });
        return;
      }
      case 'PlayAudio': {
        const clip = refs(c.m_Clips).length ? null : (c.m_Clips as { audio?: string }[] | undefined)?.find((x) => x?.audio)?.audio;
        if (!clip) return;
        const vk = key({ go: g.id, comp: g.data.comps.indexOf(c) });
        // the same loop started again replaces itself instead of stacking up
        if (c.LOOP) this.voices.get(vk)?.stop(0.1);
        const v = play(clip, { loop: !!c.LOOP, volume: num(c.m_Volume, 1) });
        if (c.LOOP) this.voices.set(vk, v);
        if (c.m_IsControlledEndTime) void this.sleep(num(c.m_ControlledEndTime, 1)).then(() => v?.stop());
        return;
      }
      case 'StopSoundLoop':
      case 'StopSoundImmediately': {
        const r = c.m_Audio as Ref | undefined;
        if (r) {
          this.voices.get(key(r))?.stop(c.t === 'StopSoundImmediately' ? 0 : 0.15);
          this.voices.delete(key(r));
        }
        return;
      }
      case 'RunAnimation':
        for (const r of refs(c.skeletonAnimation)) {
          const o = this.scene.get(r);
          const sp = o?.spine;
          if (!o || !sp) continue;
          const name = c.anim_name as string;
          if (!sp.skeleton.data.findAnimation(name)) {
            this.qa.missingAnim.add(`${o.name}:${name}`);
            continue;
          }
          if (c.SetToSetupPoseEachTime) sp.skeleton.setToSetupPose();
          sp.state.timeScale = num(c.timeScale, 1);
          const e = sp.state.setAnimation(0, name, !!c.isLoop);
          const add = c.anim_name_additional as string;
          if (add && sp.skeleton.data.findAnimation(add)) sp.state.addAnimation(0, add, !!c.isLoop_AdditionalAnim, 0);
          if (c.DisableOnDone) e.listener = { complete: () => o.setActive(false) };
        }
        return;
      case 'RemoteRunAnimation': {
        const o = this.scene.get(c.m_SkeletonAnimation as Ref);
        const sp = o?.spine;
        const steps = (c.m_ListAnimStep as { name: string; track: number; loop: number }[]) ?? [];
        if (!sp) return;
        steps.forEach((s, i) => {
          if (!sp.skeleton.data.findAnimation(s.name)) {
            this.qa.missingAnim.add(`${o.name}:${s.name}`);
            return;
          }
          if (i === 0) sp.state.setAnimation(s.track ?? 0, s.name, !!s.loop);
          else sp.state.addAnimation(s.track ?? 0, s.name, !!s.loop, 0);
        });
        return;
      }
      case 'RemoteTween':
      case 'RemoteEvent': {
        const jobs: Promise<void>[] = [];
        for (const r of refs(c.m_ListTween)) {
          const tg = this.scene.get(r);
          const tc = this.scene.compOf(r);
          if (tg && tc) jobs.push(isTask(tc) ? this.interactive(tg, tc) : this.action(tg, tc));
        }
        this.invoke(c.tweenEvent);
        await Promise.all([...jobs, this.runList(g.children.filter((o) => !o.comp('ManualTweenQueue')))]);
        return;
      }
      case 'CallTweenFunction':
        this.invoke(c.action);
        return;
      case 'SetDraggableItemToObject': {
        const it = this.scene.get(c.m_DraggableItem as Ref);
        const slot = c.m_ObjectSlot as Ref | undefined;
        if (it && slot) this.dragItemFor.set(key(slot), it);
        return;
      }
      case 'MoveObjectInPath': {
        const o = this.scene.get(c.m_Object as Ref);
        const path = this.gosOf(c.m_ListPath).map((p) => p.worldPos());
        if (!o || !path.length) return;
        const per = (T || 1) / path.length;
        for (const p of path) await this.moveTo(o, p, per);
        return;
      }
      case 'PlayFadeTransition': {
        // black curtain: fade in, jump the camera, fade out
        const cover = new Graphics().rect(-5000, -5000, 10000, 10000).fill(0x000000);
        cover.alpha = 0;
        this.app.stage.addChild(cover);
        await this.tween(0.35, (k) => (cover.alpha = k));
        const t = this.scene.get(c.afterTransitionPosition as Ref);
        if (t) {
          const p = t.worldPos();
          this.scene.camX = p.x;
          this.scene.camY = p.y;
          this.relayout();
        }
        await this.sleep(Math.max(0.2, num(c.endDelay, 0.5) * 0.5));
        await this.tween(0.35, (k) => (cover.alpha = 1 - k));
        cover.destroy();
        return;
      }
      case 'WobbleTween': {
        const o = this.scene.get(c.wobbleObject as Ref);
        if (!o) return;
        const r0 = o.view.rotation;
        const a = (num(c.m_Angle, 10) * Math.PI) / 180;
        const n = Math.max(1, num(c.m_LoopTime, 3));
        const d = num(c.m_Duration, 0.1);
        for (let i = 0; i < n; i++) {
          const s = i % 2 ? -1 : 1;
          await this.tween(d, (k) => (o.view.rotation = r0 + s * a * Math.sin(k * Math.PI)));
        }
        o.view.rotation = r0;
        return;
      }
      case 'ShowEmoji': {
        const o = this.scene.get(c.m_GameObj as Ref);
        const clip = (c.m_AudioClip as { audio?: string } | undefined)?.audio;
        if (clip) play(clip);
        if (!o) return;
        o.setActive(true);
        const sx = o.view.scale.x;
        const sy = o.view.scale.y;
        await this.tween(0.25, (k) => o.view.scale.set(sx * (0.3 + 0.7 * k), sy * (0.3 + 0.7 * k)));
        await this.sleep(Math.max(0.3, T - 0.5));
        await this.tween(0.25, (k) => (o.view.alpha = 1 - k));
        o.setActive(false);
        o.view.alpha = 1;
        o.view.scale.set(sx, sy);
        return;
      }
      case 'TriggerTweenAddValue': {
        const r = c.triggerOnThreshold as Ref | undefined;
        const tg = this.scene.get(r);
        const tc = this.scene.compOf(r);
        if (!r || !tg || !tc) return;
        const k = key(r);
        const v = (this.thresholds.get(k) ?? 0) + num(c.valueToAdd, 1);
        this.thresholds.set(k, v);
        // triggerOnDoTween: the step that holds the counter fires it later
        if (!tc.triggerOnDoTween && v === num(tc.threshold, 1)) await this.runHolder(tc.onTriggerHolder);
        return;
      }
      case 'TriggerTweenOnThreshold':
        if ((this.thresholds.get(key({ go: g.id, comp: g.data.comps.indexOf(c) })) ?? 0) >= num(c.threshold, 1)) await this.runHolder(c.onTriggerHolder);
        return;
      case 'SetActiveDraggableItem':
        return;
      case 'PlayParticle':
      case 'PlayUIParticle': {
        const o = this.scene.get(c.m_PS as Ref);
        if (!o) return;
        const real = withChildren(o, this.emitters);
        if (real.length) {
          for (const e of real) e.play();
          if (this.qaOn) {
            let t = 0;
            let seen = false;
            const step = this.stepName;
            this.every((dt) => {
              seen ||= real.some((e) => e.alive > 0) || !o.activeInHierarchy;
              if ((t += dt) < 0.8 && !seen) return false;
              if (!seen) this.qa.noFx.add(`${step}: ${o.name}`);
              return true;
            });
          }
          return;
        }
        const kind = kindOf(o.name + ' ' + (o.parent?.name ?? ''));
        // an effect carried by a tool aims at the tool's working spot
        let tool: GO | null = null;
        for (let a: GO | null = o; a; a = a.parent) if (a.comps().some((x) => 'm_DragCollider' in x)) { tool = a; break; }
        const aim = tool ? () => (tool!.activeInHierarchy ? this.toolPoint(tool!) : null) : undefined;
        // impacts (dirty drips, mud, grinder sparks) happen where the tool touches the surface
        const atImpact = aim && (kind === 'dirtydrop' || kind === 'mud' || kind === 'spark');
        const at = atImpact ? () => (o.activeInHierarchy ? aim!() : null) : () => (o.activeInHierarchy ? o.worldPos() : null);
        if (c.isLoop) this.fx.loop(key(c.m_PS as Ref), kind, at, atImpact ? undefined : aim, o.name);
        else {
          const p = o.worldPos();
          this.fx.burst(kind, p.x, p.y, 14, 0.8);
        }
        return;
      }
      case 'StopParticleForce': {
        if (c.m_PS) this.fx.stop(key(c.m_PS as Ref));
        const o = this.scene.get(c.m_PS as Ref);
        if (o) for (const e of withChildren(o, this.emitters)) e.stop();
        return;
      }
      case 'PlayBlinkEffect': {
        const o = this.scene.get(c.m_PS as Ref) ?? g;
        const p = o.worldPos();
        const real = withChildren(o, this.emitters);
        if (real.length) for (const e of real) e.play();
        else this.fx.burst('sparkle', p.x, p.y, 22, 2.4);
        const a = (c.m_Audio as { audio?: string } | undefined)?.audio;
        if (a) play(a);
        return;
      }
      case 'SetScratchCardMode': {
        for (const r of [...refs(c.m_CardManager), ...refs(c.m_ListScratchCardManager)]) this.cards.get(key(r))?.setMode(num(c.m_ScratchMode));
        return;
      }
      case 'SetScratchCardDragItem': {
        const so = c.m_CardManager as Ref | undefined;
        const it = this.item(c.m_DraggableItem);
        if (so && it) this.toolFor.set(key(so), it);
        return;
      }
      case 'ReleaseDraggableItemTween': {
        const it = this.item(c.m_ItemToRelease);
        if (it && this.drag?.item === it) this.pointerUp();
        return;
      }
      case 'SetTimescaleAnimation': {
        const sp = this.scene.get(c.m_SkeletionAnimation as Ref)?.spine;
        if (sp) sp.state.timeScale = num(c.m_TimeScale, 1);
        return;
      }
      case 'StopAnimationForce': {
        const sp = this.scene.get(c.ske as Ref)?.spine;
        if (sp) {
          sp.state.clearTracks();
          if (c.m_ResetPose) sp.skeleton.setToSetupPose();
        }
        return;
      }
      case 'ChangeSkinSpineAnimation': {
        const sp = this.scene.get(c.m_Animation as Ref)?.spine;
        try {
          sp?.skeleton.setSkinByName(c.m_SkinName as string);
          sp?.skeleton.setSlotsToSetupPose();
        } catch {
          /* skin missing */
        }
        return;
      }
      case 'FadeSpine':
        await Promise.all(this.gosOf(c.m_ListSpine).map((o) => this.tween(T || 0.3, (k) => (o.view.alpha = 1 - k)).then(() => o.setActive(false)).then(() => (o.view.alpha = 1))));
        return;
      case 'MoveObjectLocalPosition': {
        const o = this.scene.get(c.m_GameObj as Ref);
        const goal = c.goal as { x?: number; y?: number } | undefined;
        if (!o || !goal) return;
        const x0 = o.view.position.x;
        const y0 = o.view.position.y;
        const gx = goal.x ?? 0;
        const gy = goal.y ?? 0;
        await this.tween(c.m_Snap ? 0 : T || 0.3, (k) => o.view.position.set(x0 + (gx - x0) * k, y0 + (gy - y0) * k));
        return;
      }
      case 'TweenSetParentTransform': {
        const o = this.scene.get(c.m_ChildObject as Ref);
        const np = this.scene.get(c.m_NewParent as Ref);
        if (!o || !np) return;
        const p = o.worldPos();
        np.view.addChild(o.view);
        o.parent?.children.splice(o.parent.children.indexOf(o), 1);
        o.parent = np;
        np.children.push(o);
        o.setWorldPos(p.x, p.y);
        return;
      }
      case 'MoveObjectByOffset': {
        // moveDirection: up, down, left, right, up-left, up-right, down-left, down-right
        const D = [[0, 1], [0, -1], [-1, 0], [1, 0], [-0.71, 0.71], [0.71, 0.71], [-0.71, -0.71], [0.71, -0.71]];
        const [dx, dy] = D[num(c.moveDirection)] ?? [0, 1];
        const f = num(c.force, 5);
        await Promise.all(this.gosOf(c.targetObjects).map((o) => { const p = o.worldPos(); return this.moveTo(o, new Point(p.x + dx * f, p.y + dy * f), T || 0.5); }));
        return;
      }
      case 'EnableOutlineSprite':
        if (c.IsActive !== 0) this.behaviors.flash(this.gosOf(c.m_ListSpriteRenderer), num(c.firstShowDuration, 2));
        return;
      case 'SetTweenColorSprite':
      case 'SetTweenColorSkeletonAnimation': {
        // a blinking highlight: alpha between the two colours, loopTime times
        const o = this.scene.get((c.m_Sprite ?? c.m_Animation) as Ref);
        if (!o) return;
        const a = (v: unknown) => (((v as { rgba?: number })?.rgba ?? 0xffffffff) >>> 24) / 255;
        const a0 = a(c.startColor);
        const a1 = a(c.endColor);
        const n = Math.max(1, num(c.loopTime, 3));
        const d = num(c.duration, 0.25);
        for (let i = 0; i < n * 2; i++) await this.tween(d, (k) => (o.view.alpha = i % 2 ? a1 + (a0 - a1) * k : a0 + (a1 - a0) * k));
        o.view.alpha = 1;
        return;
      }
      case 'ShakingObject': {
        const dur = num(c.m_Duration, 0.3);
        const str = num(c.m_Strength, 0.1);
        await Promise.all(
          this.gosOf(c.m_ListGameObject, c.m_GameObj).map((o) => {
            const x0 = o.view.position.x;
            const y0 = o.view.position.y;
            return this.tween(dur, (k) => {
              const f = c.m_FadeOut ? 1 - k : 1;
              o.view.position.set(x0 + (Math.random() - 0.5) * 2 * str * f, y0 + (Math.random() - 0.5) * 2 * str * f);
              if (k >= 1) o.view.position.set(x0, y0);
            });
          }),
        );
        return;
      }
      case 'SetToolUIProgressManualTween':
      case 'SetToolUIProgressTween': {
        const sp = ((c.m_OverrideSprite ?? c.m_Sprite) as { sprite?: string } | undefined)?.sprite;
        const item = this.scene.get(c.item as Ref);
        const tex = sp && Assets.cache.has('s:' + sp) ? Assets.get<Texture>('s:' + sp) : item ? this.ui.iconOf(item) : null;
        this.badge.show(tex);
        return;
      }
      case 'SetActiveCamZone':
        this.camZone = c.m_IsActive ? { h: !!c.m_HorizontalMove, v: !!c.m_VerticalMove } : null;
        return;
      default:
        return; // vibration, outlines, tool thumbnails, VFX settings: nothing to show on the web
    }
  }

  relayout(): void {
    this.scene.layout(this.app.screen.width, this.app.screen.height);
  }

  /** Latest move per object: a newer move (script or snap-back) overrides an older one. */
  private moveGen = new Map<number, number>();

  /** Resolves true when this move ran to the end (no newer move or grab took over). */
  private async moveTo(o: GO, to: Point, sec: number, fromDrag = false): Promise<boolean> {
    const gen = (this.moveGen.get(o.id) ?? 0) + 1;
    this.moveGen.set(o.id, gen);
    // the script takes the tool out of the player's hand
    if (!fromDrag && this.drag?.item === o) this.dropDrag();
    const from = o.worldPos();
    await this.tween(sec, (k) => {
      if (this.moveGen.get(o.id) === gen) o.setWorldPos(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k);
    });
    return this.moveGen.get(o.id) === gen;
  }

  // ---- interactive tasks ----------------------------------------------------

  private running = new Map<string, Promise<void>>();
  readonly trace: string[] = [];
  /** QA: how many visible things changed during each step. */
  readonly stepChanges: { step: string; changed: number }[] = [];
  private toolIds: Set<number> | null = null;

  /** What the player can see of each drawn object: shown, alpha, position, animation. */
  private visualState(): Map<number, string> {
    const m = new Map<number, string>();
    if (!this.toolIds) {
      // tools move in and out every step: they count only when they end up elsewhere
      this.toolIds = new Set();
      const TOOL_TASKS = new Set(['ScratchObject', 'ScratchObject_DragToolSwap', 'DragCollider', 'DragColliderOptions', 'DragObjectMultiSlot', 'DragObjectMultipleSlot_ToolSwap', 'HoldAndMoveIn', 'BugKill3ToolsDrag']);
      for (const g of this.scene.gos)
        for (const c of g.comps()) {
          if (!TOOL_TASKS.has(c.t)) continue;
          for (const v of [c.m_DraggableItem, c.m_DragItem, c.m_Dragitem, c.m_Tool1, c.m_Tool2, c.m_Tool3])
            for (const t of this.gosOf(v)) for (const d of [t, ...descendants(t)]) this.toolIds.add(d.id);
        }
    }
    for (const g of this.scene.gos) {
      const r = g.sprite ?? g.spine;
      if (!r) continue;
      const p = g.activeInHierarchy ? g.worldPos() : g.view.position;
      const anim = g.spine?.state.getCurrent(0)?.animation?.name ?? '';
      const tint = g.sprite?.tint ?? 0xffffff;
      m.set(g.id, `${g.activeInHierarchy ? 1 : 0}|${r.renderable ? 1 : 0}|${(g.view.alpha * (g.sprite?.alpha ?? 1)).toFixed(2)}|${p.x.toFixed(1)},${p.y.toFixed(1)}|${anim}|${g.sprite?.texture.uid ?? ''}|${tint}`);
    }
    for (const [k, c] of this.cards) m.set(-1 - m.size, `${k}:${c.progress.toFixed(2)}`);
    return m;
  }

  /** Objects that differ from `before`; tools only at the end of the step. */
  private diffIds(before: Map<number, string>, end: boolean): number[] {
    const out: number[] = [];
    for (const [k, v] of this.visualState()) if (before.get(k) !== v && (end || !this.toolIds?.has(k))) out.push(k);
    return out;
  }

  /** QA: sprites a FadeSprite brought in. */
  readonly fadedIn = new Set<GO>();
  /** DragObjectMultiSlot -> item handed to it by SetDraggableItemToObject / SetDragItem. */
  private dragItemFor = new Map<string, GO>();
  /** InteractiveMultiTool.AddProgress counters. */
  private multiProgress = new Map<string, number>();
  /** TriggerTweenOnThreshold counters. */
  private thresholds = new Map<string, number>();

  /** Unity events (UnityEvent persistent calls) of RemoteEvent / CallTweenFunction. */
  private invoke(ev: unknown): void {
    type Call = { m_Target?: Ref; m_MethodName?: string; m_Arguments?: { m_ObjectArgument?: Ref | null; m_IntArgument?: number; m_BoolArgument?: number } };
    const calls = (ev as { m_PersistentCalls?: { m_Calls?: Call[] } } | undefined)?.m_PersistentCalls?.m_Calls ?? [];
    for (const call of calls) {
      const tg = this.scene.get(call.m_Target);
      if (!tg) continue;
      const tc = this.scene.compOf(call.m_Target as Ref);
      const arg = call.m_Arguments ?? {};
      switch (call.m_MethodName) {
        case 'DoDie':
          if (!this.behaviors.kill(tg)) void this.tween(0.5, (k) => (tg.view.alpha = 1 - k)).then(() => tg.setActive(false));
          break;
        case 'DoStop':
          this.behaviors.stop(tg);
          break;
        case 'SetActive':
          tg.setActive(!!arg.m_BoolArgument);
          break;
        case 'set_enabled':
          if (tc?.t?.includes('Collider') || tc?.t === 'BoxCollider' || tc?.t === 'BoxCollider2D') for (const k of tg.colliders) k.enabled = !!arg.m_BoolArgument;
          break;
        case 'AddProgress':
          if (call.m_Target) {
            const k = key(call.m_Target);
            this.multiProgress.set(k, (this.multiProgress.get(k) ?? 0) + (num(arg.m_IntArgument) || 1));
          }
          break;
        case 'DisableCollider':
          for (const k of tg.colliders) k.enabled = false;
          break;
        case 'SetDragItem': {
          const it = this.scene.get(arg.m_ObjectArgument ?? undefined);
          if (it && call.m_Target) this.dragItemFor.set(key(call.m_Target), it);
          break;
        }
        case 'DoStartStep': {
          const st = tg.children[num(arg.m_IntArgument)];
          if (st) void this.runList(st.children);
          break;
        }
        case 'DoTouchUp':
          if (this.drag?.item === tg) this.pointerUp();
          break;
        case 'StartTween':
        case 'SetTweenActive':
        case 'RunTween':
          if (tc && isTask(tc)) void this.interactive(tg, tc);
          else if (tc) void this.action(tg, tc);
          break;
        default:
          // progress bars, rewards, raycast toggles: nothing to show here
          break;
      }
    }
  }

  /** Last option picked in a ChooseOption* UI (ToolSwap reads it). */
  private lastChoice: GO | null = null;
  /** ScratchObject -> tool chosen by a ToolSwap. */
  private toolFor = new Map<string, GO>();
  /** Every DragColliderTarget / slot trigger, for InteractiveMultiTool progress. */
  private triggers = 0;

  private interactive(g: GO, c: CompData): Promise<void> {
    const k = key({ go: g.id, comp: g.data.comps.indexOf(c) });
    const hit = this.running.get(k);
    if (hit) return hit;
    const p = new Promise<void>((resolve) => {
      const task = this.makeTask(g, c, resolve);
      this.trace.push(`${this.stepName}: ${c.t} ${g.name} ${task ? task.items.map((i) => i.name).join(',') || '-' : 'NULL'}`);
      if (!task) {
        resolve();
        return;
      }
      task.key = k;
      task.kind ??= c.t;
      task.born = this.time;
      for (const it of task.items) this.qaTools.add(it);
      this.tasks.push(task);
    }).finally(() => {
      this.running.delete(k);
      if (this.stepKeys.has(k)) this.stepDoneKeys.add(k);
    });
    this.running.set(k, p);
    return p;
  }

  /** ParallelInteractiveItem (m_RunDoTweenOfChildItems) -> closing actions of its parts. */
  private groupEnd = new Map<GO, Fn0[]>();

  /** Runs `f` now, or when the part's ParallelInteractiveItem group is done. */
  private afterGroup(part: GO, f: Fn0): void {
    const par = part.parent;
    const pc = par?.comp('ParallelInteractiveItem');
    if (par && pc && num(pc.m_RunDoTweenOfChildItems) && this.tasks.some((t) => t.key?.startsWith(`${par.id}:`) && !t.done)) {
      const list = this.groupEnd.get(par) ?? [];
      list.push(f);
      this.groupEnd.set(par, list);
    } else f();
  }

  /** Drop the tasks still waiting (e.g. the tools the player did not pick). */
  private dropTasks(keys?: Set<string>): void {
    for (const t of [...this.tasks]) if (!keys || (t.key && keys.has(t.key))) t.finish();
    if (!keys) {
      // a step ending with a group still open: its tools are put away all the same
      const later = [...this.groupEnd.values()].flat();
      this.groupEnd.clear();
      for (const f of later) f();
    }
  }

  private endTask(task: Task, resolve: () => void): void {
    if (task.done) return;
    task.done = true;
    this.tasks = this.tasks.filter((t) => t !== task);
    if (this.drag?.task === task) {
      // another task may still use the item in hand (scratch + nested trigger task)
      const other = this.tasks.find((t) => t.items.includes(this.drag!.item));
      if (other) this.drag.task = other;
      else this.dropDrag();
    }
    resolve();
  }

  private item(r: unknown): GO | undefined {
    return isRef(r) ? this.scene.get(r) : undefined;
  }

  private makeTask(g: GO, c: CompData, resolve: () => void): Task | null {
    const task: Task = { items: [], kind: c.t, done: false, finish: () => this.endTask(task, resolve) };
    const at = (o: GO | undefined) => (o ? [o.worldPos()] : []);
    switch (c.t) {
      case 'ToolTrashCan': {
        const can = this.item(c.m_ColTrashCan);
        const end = this.item(c.m_PosEndDrop);
        task.items = this.gosOf(c.m_ListDragItem).filter((o) => o.activeInHierarchy);
        const left = new Set(task.items);
        const total = left.size;
        task.progress = () => 1 - left.size / Math.max(1, total);
        task.onGrab = (it) => void this.runHolder(it.comp('DragObjectMultiDragItem')?.m_TweenOnStartDragHolder);
        task.onRelease = (it) => {
          if (!can || !this.overlap(it, can, 0.8)) return false;
          left.delete(it);
          task.items = task.items.filter((o) => o !== it);
          const p = (end ?? can).worldPos();
          const pc = it.comp('DragObjectMultiDragItem');
          void this.moveTo(it, p, 0.25).then(() => {
            void this.runHolder(pc?.m_TweenOnDoneHolder);
            this.runRefs(pc?.m_ListTweenOnDone);
            it.setActive(false);
            const dust = this.scene.get(c.m_TrashDust as Ref);
            const real = dust ? withChildren(dust, this.emitters) : [];
            if (real.length) for (const e of real) e.play();
            else this.fx.burst('dust', p.x, p.y + 0.3, 8, 0.8);
          });
          play((c.m_SoundDrop as { audio?: string } | undefined)?.audio ?? 'Drop_Items');
          if (!left.size) void this.sleep(0.3).then(task.finish);
          return true;
        };
        if (!left.size) return null;
        task.goals = () => at(can);
        return task;
      }
      case 'DragCollider': {
        const it = this.item(c.m_DragItem);
        // unique targets (a list may name the same one several times)
        const targets = [...new Set(refs(c.m_ListTarget).map((r) => this.scene.get(r)).filter((o): o is GO => !!o))];
        if (!it) return null;
        // the task arms its targets (their colliders start disabled in many levels)
        if (c._options || targets.every((t) => !t.colliders.some((k) => k.enabled))) for (const t of targets) t.colliders.forEach((k) => (k.enabled = true));
        const live = (t: GO) => t.selfActive && t.colliders.some((k) => k.enabled);
        const fired = new Set<GO>();
        const allDone = () => targets.every((t) => fired.has(t) || !live(t));
        task.items = [it];
        task.progress = () => fired.size / Math.max(1, targets.filter((t) => fired.has(t) || live(t)).length);
        task.onMove = (m) => {
          for (const t of targets) {
            if (fired.has(t) || !live(t)) continue;
            if (this.overlap(m, t)) {
              fired.add(t);
              this.triggers++;
              void this.runList(t.children);
              // targets switched on by this trigger join the list on the next frame
              // DragColliderOptions: the targets are alternatives, the first one hit does the job
              // (its own actions put the tool away)
              if (c._options) {
                void this.sleep(0.05).then(() => task.finish());
                return;
              }
              if (c.m_DoTaskDoneOnTrigger) void this.sleep(0.05).then(() => allDone() && task.finish());
            }
          }
        };
        task.onRelease = () => {
          if (fired.size && allDone()) task.finish();
          return fired.size > 0;
        };
        task.goals = () => targets.filter((t) => !fired.has(t) && live(t)).map((t) => {
          const r = this.rect(t);
          return this.scene.world.toLocal(new Point(r.x + r.width / 2, r.y + r.height / 2));
        });
        return task;
      }
      case 'DragObject': {
        const it = this.item(c.m_DragItem);
        const target = this.item(c.m_Target);
        if (!it || !target) return null;
        task.items = [it];
        task.onRelease = (m) => {
          if (!this.overlap(m, target, 0.6)) return false;
          if (c.m_SnapOnDone) void this.moveTo(m, target.worldPos(), 0.2);
          void this.runHolder(c.ActionsOnDoneHolder);
          task.finish();
          return true;
        };
        task.goals = () => at(target);
        return task;
      }
      case 'PluckObject': {
        const it = this.item(c.m_PluckItem);
        if (!it) return null;
        const max = num(c.maxDistance, 3);
        task.items = [it];
        task.onMove = (m) => {
          if (this.drag && Math.hypot(m.worldPos().x - this.drag.start.x, m.worldPos().y - this.drag.start.y) > max * 0.6) {
            this.dropDrag();
            void this.tween(0.4, (k) => (m.view.alpha = 1 - k)).then(() => m.setActive(false));
            void this.runHolder(c.ActionsOnDoneHolder);
            task.finish();
          }
        };
        task.goals = () => {
          const p = it.worldPos();
          return [new Point(p.x + max, p.y + max)];
        };
        return task;
      }
      case 'DragObjectMultiSlot':
      case 'DragObjectMultipleSlot_ToolSwap': {
        const given = this.dragItemFor.get(key({ go: g.id, comp: g.data.comps.indexOf(c) }));
        let items = given ? [given] : this.gosOf(c.m_DragItem);
        if (c.t === 'DragObjectMultipleSlot_ToolSwap') {
          const choices = refs(c.m_ChooseOptionItems).map((r) => r.go);
          const idx = Math.max(0, this.lastChoice ? choices.indexOf(this.lastChoice.id) : 0);
          const tool = items[idx] ?? items[0];
          void this.runHolder(refs(c.m_OnSelectTool)[idx]);
          items = tool ? [tool] : [];
          const so = c.m_ScratchObject as Ref | undefined;
          if (so && tool) this.toolFor.set(key(so), tool);
          // put the tool away when its job (slots + scratch) is done
          const close = refs(c.m_OnCloseTool)[idx];
          const fin = task.finish;
          task.finish = () => {
            if (task.done) return;
            fin();
            const sp = so ? this.running.get(key(so)) : undefined;
            void (sp ?? Promise.resolve()).then(() => this.afterGroup(g, () => void this.runHolder(close)));
          };
        }
        const seen = new Set<number>();
        const slots = refs(c.m_ListSlot)
          .filter((r) => !seen.has(r.go) && seen.add(r.go))
          .map((r) => ({ go: this.scene.get(r)!, comp: this.scene.compOf(r) }))
          .filter((s) => s.go);
        if (!items.length || !slots.length) return null;
        const fired = new Set<GO>();
        // slots switched off by the level do not have to be touched
        const allDone = () => slots.every((s) => fired.has(s.go) || !s.go.selfActive);
        task.items = items;
        task.progress = () => fired.size / Math.max(1, slots.filter((s) => fired.has(s.go) || s.go.selfActive).length);
        task.onMove = (m) => {
          for (const s of slots) {
            if (fired.has(s.go) || !s.go.selfActive) continue;
            if (this.overlap(m, s.go, 1.2)) {
              fired.add(s.go);
              this.triggers++;
              void this.runHolder(s.comp?.m_TweenOnTriggerHolder);
              if (allDone()) task.finish();
            }
          }
        };
        task.goals = () => slots.filter((s) => !fired.has(s.go) && s.go.selfActive).map((s) => this.centre(s.go));
        task.left = task.goals;
        task.onRelease = () => {
          if (allDone()) task.finish();
          return false;
        };
        return task;
      }
      case 'ScratchObject':
      case 'ScratchObject_DragToolSwap': {
        // the tool picked for the linked slot task (SoapCleaningMethods: sponge OR soap spray) wins
        // over the one written in the component, else picking the other tool leaves it waiting
        let it = this.toolFor.get(key({ go: g.id, comp: g.data.comps.indexOf(c) })) ?? this.item(c.m_DraggableItem);
        if (c.t === 'ScratchObject_DragToolSwap') {
          const idx = this.choiceIndex(c.m_ChooseOptionItems);
          it = this.gosOf(c.m_DragItem)[idx] ?? it;
          void this.runHolder(refs(c.m_OnSelectTool)[idx]);
          const close = refs(c.m_OnCloseTool)[idx];
          const fin = task.finish;
          task.finish = () => {
            if (task.done) return;
            fin();
            // in a ParallelInteractiveItem the tool is shared (e.g. scratch + slots with the same
            // spray): it is put away when the whole group is done, not when this part is
            this.afterGroup(g, () => void this.runHolder(close));
          };
        }
        const cards = refs(c.m_ListScratchCard).map((r) => this.cards.get(key(r))).filter((x): x is ScratchCard => !!x);
        if (!it || !cards.length) return null;
        for (const k of cards) k.go.setActive(true);
        const need = (k: ScratchCard) => (k.mode === 0 ? num(c.m_FillRateErase, 0.7) : 1 - num(c.m_FillRateRestore, 0.3));
        let half = false;
        task.items = [it];
        task.progress = () => cards.reduce((a, k) => a + Math.min(1, k.progress / need(k)), 0) / cards.length;
        const soGo = g;
        const onScr = this.scene.gos
          .flatMap((o) => o.comps().filter((x) => (x.t === 'TweenOnScratchingCard' || x.t === 'TweenOnScratchingCard_2') && (x.ScratchObject as Ref)?.go === soGo.id))
          .concat(g.comps().filter((x) => (x.t === 'TweenOnScratchingCard' || x.t === 'TweenOnScratchingCard_2') && !x.ScratchObject));
        const colorLerp = this.scene.gos.flatMap((o) => o.comps().filter((x) => x.t === 'ColorLerpByScratchCompleteProgress' && (x.m_ScratchObject as Ref)?.go === soGo.id));
        const trig = g.comps().filter((x) => x.t === 'TweenOnTriggerScratchCardProgress').flatMap((x) => (x.m_ListTrigger as { m_ProgressTrigger: number; m_ListTween: Ref[] }[]) ?? []);
        const trigDone = new Set<number>();
        let scrubbing = false;
        const fxKind: FxKind = cards[0].mode === 1 ? (/water|spray|hose|nozzle/i.test(it.name) ? 'drop' : 'bubble') : /water|spray|hose|nozzle/i.test(it.name) ? 'drop' : 'dust';
        // the scrubbing effects (foam, particles, sounds) are on while the tool rubs the surface
        // and go off a moment after it stops or leaves it (TweenOnScratchingCard begin/end)
        let lastHit = -1;
        let best = 0;
        let gainAt = this.time;
        const endScrub = () => {
          if (!scrubbing) return;
          scrubbing = false;
          for (const o of onScr) this.runRefs(o.m_OnEndScratch);
        };
        this.every(() => {
          if (task.done) return true;
          if (scrubbing && this.time - lastHit > 0.25) endScrub();
        });
        let lastP: Point | null = null;
        let lastAt = -1;
        // a tool with no working sound of its own and no scrubbing sound in the level: a
        // rubbing / sweeping / water sound from the game's clips, by what the tool is
        const hasOwn = !!(it.comps().find((x) => 'm_Audio' in x)?.m_Audio as { audio?: string } | undefined)?.audio || onScr.length > 0 || !!c.actionOnScratchingHolder;
        const scrubSound = hasOwn
          ? undefined
          : /broom|sweep|duster|feather|web/i.test(it.name)
            ? 'Sweeping'
            : /spray|water|hose|nozzle/i.test(it.name)
              ? 'Water_Nozzle_Spray_1_Loop'
              : /soap|foam/i.test(it.name)
                ? 'Soap_Loop'
                : /vacuum/i.test(it.name)
                  ? 'Vacuum_Cleaner_Liquid'
                  : 'Rubbing';
        task.onMove = (m) => {
          const p = this.toolPoint(m);
          // a swipe is a line, not dots: stamp along the way from the previous point
          const from = lastP && this.time - lastAt < 0.3 && Math.hypot(p.x - lastP.x, p.y - lastP.y) < 5 ? lastP : null;
          lastP = p;
          lastAt = this.time;
          const toG = (q: Point) => this.scene.world.toGlobal(q);
          let hit = false;
          for (const k of cards) hit = (from ? k.scratchLine(from, p, 0.75, toG) : k.scratchAt(p, 0.75, toG)) || hit;
          if (!hit) return;
          lastHit = this.time;
          this.toolWorking(scrubSound);
          if (Math.random() < 0.35) this.fx.burst(fxKind, p.x, p.y, 1, 0.5);
          if (!scrubbing) {
            scrubbing = true;
            for (const o of onScr) this.runRefs(o.m_OnBeginScratch);
            void this.runHolder(c.actionOnScratchingHolder);
          }
          // the object changes while it is being cleaned
          const frac = (k: ScratchCard) => Math.min(1, k.progress / need(k));
          for (const f of this.fadeByCard) {
            const k = cards.find((x) => key({ go: x.go.id, comp: x.go.data.comps.indexOf(x.data) }) === f.card);
            if (k) for (const sgo of f.sprites) if (sgo.sprite) sgo.sprite.alpha = f.down ? sgo.baseAlpha * (1 - frac(k)) : frac(k);
          }
          const total = cards.reduce((a, k) => a + frac(k), 0) / cards.length;
          for (const cl of colorLerp) {
            const sgo = this.scene.get(cl.m_Sprite as Ref);
            const c0 = cl.m_ColorStart as { r?: number; g?: number; b?: number; a?: number };
            const c1 = cl.m_ColorEnd as { r?: number; g?: number; b?: number; a?: number };
            if (!sgo?.sprite) continue;
            const mix = (a?: number, b?: number) => Math.round(255 * ((a ?? 1) + ((b ?? 1) - (a ?? 1)) * total));
            sgo.sprite.tint = (mix(c0.r, c1.r) << 16) | (mix(c0.g, c1.g) << 8) | mix(c0.b, c1.b);
            sgo.sprite.alpha = (c0.a ?? 1) + ((c1.a ?? 1) - (c0.a ?? 1)) * total;
          }
          trig.forEach((tr, i) => {
            if (!trigDone.has(i) && total >= tr.m_ProgressTrigger) {
              trigDone.add(i);
              this.runRefs(tr.m_ListTween);
            }
          });
          const avg = cards.reduce((s, k) => s + Math.min(1, k.progress / need(k)), 0) / cards.length;
          if (!half && avg >= 0.5 && c.tweenOnHalf) {
            half = true;
            void this.runHolder(c.m_TweenOnHalfHolder);
          }
          // safety net: still rubbing, mostly clean, and nothing more comes off (the last bits are
          // where this mask approximation and the original's differ): the job counts as done
          if (avg > best + 0.002) {
            best = avg;
            gainAt = this.time;
          }
          const stalled = avg >= 0.75 && this.time - gainAt > 1.2;
          if (stalled || avg >= 0.96 || cards.every((k) => k.progress >= need(k))) {
            cards.forEach((k) => k.complete());
            void this.runHolder(c.actionHolder);
            void this.runHolder(c.m_OnDoneScratch);
            task.finish();
          }
        };
        task.goals = () => cards.flatMap((k) => k.sweep());
        task.left = () => cards.flatMap((k) => (k.progress < need(k) ? k.remaining(3) : []));
        task.onRelease = () => {
          lastP = null;
          endScrub();
          return false;
        };
        const fin0 = task.finish;
        task.finish = () => {
          if (task.done) return;
          endScrub();
          for (const f of this.fadeByCard) if (cards.some((x) => key({ go: x.go.id, comp: x.go.data.comps.indexOf(x.data) }) === f.card)) for (const sgo of f.sprites) if (sgo.sprite && f.down) void this.tween(0.3, (k) => (sgo.sprite!.alpha *= 1 - k));
          fin0();
        };
        return task;
      }
      case 'ParallelInteractiveItem': {
        const subs: Promise<void>[] = [];
        for (const ch of g.children)
          for (const cc of ch.comps()) {
            if (!isTask(cc)) continue;
            if (ch.selfActive) subs.push(this.interactive(ch, cc));
            else
              // switched on later by the script (saw placed -> hold to saw): start it then
              subs.push(
                new Promise<void>((res) => {
                  this.every(() => {
                    if (task.done) {
                      res();
                      return true;
                    }
                    if (!ch.activeInHierarchy) return false;
                    void this.interactive(ch, cc).then(res);
                    return true;
                  });
                }),
              );
          }
        void Promise.all(subs).then(() => {
          // m_RunDoTweenOfChildItems: the parts' closing tweens (tools put away) run now
          const later = this.groupEnd.get(g) ?? [];
          this.groupEnd.delete(g);
          for (const f of later) f();
          task.finish();
        });
        return task;
      }
      case 'ChooseOption':
      case 'ChooseOptionTool': {
        const opts = refs(c.m_ListOption).map((r) => this.scene.get(r)).filter((o): o is GO => !!o);
        if (!opts.length) return null;
        void this.ui.choose(opts, c.t === 'ChooseOptionTool' ? 'Chọn dụng cụ' : 'Chọn một kiểu').then(async (o) => {
          this.lastChoice = o;
          const nc = o.comps().find((x) => 'namecode' in x)?.namecode as string | undefined;
          if (c.m_ObjNamecode && nc) this.onChoice?.(c.m_ObjNamecode as string, nc);
          const idx = Math.max(0, opts.indexOf(o));
          const deco = g.comp('DropEffectDeco');
          if (deco) {
            // the chosen version of the object appears and falls into place, the others go
            const decos = this.gosOf(deco.m_ListDeco);
            decos.forEach((d, j) => d.setActive(j === idx));
            const d = decos[idx];
            if (d) {
              const y1 = d.view.position.y;
              await this.tween(num(deco.m_Time, 0.3) + 0.25, (k) => (d.view.position.y = y1 + num(deco.m_Distance, 6) * 0.25 * (1 - k * k)));
              d.view.position.y = y1;
            }
            const ps = this.scene.get(deco.m_PS as Ref);
            if (ps) for (const e of withChildren(ps, this.emitters)) e.play();
            play('Item_Drop');
          }
          const oc = o.comps().find((x) => 'm_TweenHolder' in x || 'm_ListTweenOnClick' in x);
          this.runRefs(oc?.m_ListTweenOnClick);
          const per = [c.m_TweenOnChooseOne, c.m_TweenOnChooseTwo, c.m_TweenOnChooseThree, c.m_TweenOnChooseFour][idx];
          if (per) await this.runHolder(per);
          if (oc) await this.runHolder(oc.m_TweenHolder);
          await this.runList(o.children);
          const fx = this.scene.get(c.m_ParticleFX as Ref);
          if (fx) for (const e of withChildren(fx, this.emitters)) e.play();
          const snd = (c.m_SoundFX as { audio?: string } | undefined)?.audio;
          if (snd) play(snd);
          task.finish();
        });
        return task;
      }
      case 'InteractiveMultiTool': {
        const models = (c.m_InteractMultiToolModels as { namecode: string; OnSelectTool: Ref; OnDeselectTool: Ref }[]) ?? [];
        const pickHolder = this.item(c.m_OptionHolder) ?? this.item(c.m_SwapOptionHolder);
        const opts = pickHolder ? descendants(pickHolder).filter((o) => o.comp('ChooseOptionItem')) : [];
        const groups = g.children.find((o) => o.name === 'Interactives')?.children ?? [];
        const onDone = g.children.find((o) => o.name === 'OnDone');
        const max = num(c.maxProgress, 1);
        const me = key({ go: g.id, comp: g.data.comps.indexOf(c) });
        this.multiProgress.set(me, 0);
        const modelOf = (o: GO | null) => Math.max(0, models.findIndex((x) => x.namecode === (o?.comp('ChooseOptionItem')?.namecode as string | undefined)));
        let cur = -1;
        let keys = new Set<string>();
        let groupDone: Promise<void> = Promise.resolve();
        // switch to tool mi: put the old one away, take the new one out, run its tasks
        const use = (mi: number) => {
          if (mi === cur) return;
          if (cur >= 0) {
            this.dropTasks(keys);
            void this.runHolder(models[cur]?.OnDeselectTool);
          }
          cur = mi;
          void this.runHolder(models[mi]?.OnSelectTool);
          keys = new Set();
          const jobs: Promise<void>[] = [];
          for (const d of groups[mi] ? descendants(groups[mi]) : [])
            for (const dc of d.comps())
              if (isTask(dc)) {
                keys.add(key({ go: d.id, comp: d.data.comps.indexOf(dc) }));
                jobs.push(this.interactive(d, dc));
              }
          groupDone = jobs.length ? Promise.all(jobs).then(() => undefined) : new Promise(() => undefined);
        };
        const pick = opts.length ? this.ui.choose(opts, 'Chọn dụng cụ') : Promise.resolve(null);
        void pick.then(async (o) => {
          use(modelOf(o));
          const t0 = this.triggers;
          let removeBar: (() => void) | null = null;
          if (c.allowSwapToolAfterSelect && opts.length > 1) removeBar = this.ui.toolBar(opts, Math.max(0, opts.indexOf(o!)), (i) => use(modelOf(opts[i])));
          await new Promise<void>((res) => {
            let doneGroup = -1;
            const watch = () => {
              const mine = cur;
              void groupDone.then(() => {
                if (cur === mine) doneGroup = mine;
              });
            };
            watch();
            let lastCur = cur;
            this.every(() => {
              if (cur !== lastCur) {
                lastCur = cur;
                watch();
              }
              // progress: AddProgress calls of the original, or the triggers hit
              const prog = Math.max(this.multiProgress.get(me) ?? 0, this.triggers - t0);
              if (prog >= max || doneGroup === cur || task.done) {
                res();
                return true;
              }
            });
          });
          removeBar?.();
          await this.sleep(0.6);
          this.dropTasks(keys);
          if (onDone) await this.runList(onDone.children);
          task.finish();
        });
        return task;
      }
      case 'DragColliderOptions':
        return this.makeTask(g, { ...c, t: 'DragCollider', m_DoTaskDoneOnTrigger: 1, _options: 1 }, resolve);
      case 'ClickObject': {
        const target = this.item(c.m_ClickObject) ?? g;
        const ci = target.comp('ClickObjectItem');
        return this.tapTask(
          task,
          [target],
          1,
          async () => {
            await Promise.all([this.runHolder(c.m_TweenClickHolder), this.runHolder(ci?.m_TweenOnClickHolder)]);
            this.runRefs(ci?.m_ListTweenOnDone);
            await this.runHolder(ci?.m_TweenOnDoneHolder);
          },
          (o) => {
            play('Take_Item_1', { volume: 0.7 });
            this.runRefs(ci?.m_ListTweenOnClick);
            if (ci?.m_DisableOnDone || c.m_DisableOnDone) o.colliders.forEach((k) => (k.enabled = false));
            if (ci?.m_HideOnDone) void this.tween(0.25, (k) => (o.view.alpha = 1 - k)).then(() => o.setActive(false));
            else void this.runList(o.children.filter((x) => x.comps().some((cc) => 'm_TweenChecker' in cc)));
          },
        );
      }
      case 'WaitForOnClick': {
        const need = Math.max(1, num(c.CountNeeded, 1));
        const area = g.colliders.length ? [g] : [];
        const onClick = g.children.find((o) => o.name === 'TweenOnClick');
        const onDone = g.children.find((o) => o.name === 'TweenOnDoneHolder');
        let n = 0;
        task.onTap = (p) => {
          if (area.length && !area.some((a) => this.contains(a, p))) return;
          n++;
          if (onClick) void this.runList(onClick.children);
          if (n >= need) {
            for (const r of refs(c.m_ListTweenOnDone)) {
              const og = this.scene.get(r);
              const oc = this.scene.compOf(r);
              if (og && oc) void this.action(og, oc);
            }
            if (onDone) void this.runList(onDone.children);
            task.finish();
          }
        };
        task.taps = () => [area[0]?.worldPos() ?? new Point(this.scene.camX, this.scene.camY)];
        return task;
      }
      case 'BookCurlObject': {
        const curls = this.gosOf(c.m_ListBookCurl);
        if (!curls.length) return null;
        let i = 0;
        const next = () => {
          const bc = curls[i++];
          play('Peel_Tape');
          void this.runHolder(bc?.comp('BookCurl')?.m_TweenOnDoneHolder);
          if (i >= curls.length) void this.sleep(0.4).then(task.finish);
        };
        task.onTap = () => next();
        task.taps = () => [new Point(this.scene.camX, this.scene.camY)];
        return task;
      }
      case 'FlySwatter': {
        const targets = this.gosOf(c.m_ListTargetColliders).filter((o) => o.activeInHierarchy);
        const smash = (c.m_SoundSmash as { audio?: string } | undefined)?.audio;
        return this.tapTask(task, targets, 1, async () => undefined, (o) => {
          if (smash) play(smash);
          void this.tween(0.3, (k) => (o.view.alpha = 1 - k)).then(() => o.setActive(false));
        });
      }
      case 'ClickToBreakTween2': {
        const targets = this.gosOf(c.m_BreakItem).filter((o) => o.activeInHierarchy);
        return this.breakTask(task, this.scene.get(c.currentTool as Ref), targets, async () => undefined);
      }
      case 'ClickToBreakTween': {
        const idx = this.choiceIndex(c.m_ChooseOptionItems);
        void this.runHolder(refs(c.m_OnSelectTool)[idx]);
        const targets = this.gosOf(c.m_BreakItem).filter((o) => o.activeInHierarchy);
        return this.breakTask(task, this.gosOf(c.m_BreakTools)[idx], targets, () => this.runHolder(refs(c.m_OnCloseTool)[idx]));
      }
      case 'BugKill3ToolsTween': {
        const bugs = this.gosOf(c.m_Bugs).filter((o) => o.activeInHierarchy);
        if (!bugs.length) return null;
        const choices = [c.m_InsecticideChoice, c.m_SlipperChoice, c.m_FlySwatterChoice].map((r) => (r as Ref | undefined)?.go);
        const which = Math.max(0, this.lastChoice ? choices.indexOf(this.lastChoice.id) : 0);
        const alive = new Set(bugs);
        task.progress = () => 1 - alive.size / bugs.length;
        const smash = ((which === 1 ? c.m_SoundSmash_Slipper : c.m_SoundSmash_FlySwatter) as { audio?: string } | undefined)?.audio ?? 'Slapping';
        // a bug dies through its own DragColliderTarget tweens (DoDie) like in the original
        const kill = (b: GO) => {
          if (!alive.delete(b)) return;
          const bc = b.comp('Cockroach') ?? b.comp('Flies') ?? b.comp('BeeBehavior');
          const dct = this.scene.get(bc?.m_DragCollider as Ref)?.comp('DragColliderTarget');
          if (refs(dct?.m_ListTweenOnActive).length) this.runRefs(dct?.m_ListTweenOnActive);
          else if (!this.behaviors.kill(b)) void this.tween(0.4, (k) => (b.view.alpha = 1 - k)).then(() => b.setActive(false));
          if (!alive.size)
            void this.sleep(0.8).then(async () => {
              if (which === 0) await this.runHolder(c.m_OnCloseInsecticide);
              task.finish();
            });
        };
        const near = (p: Point, r: number) => [...alive].filter((b) => b.activeInHierarchy && Math.hypot(b.worldPos().x - p.x, b.worldPos().y - p.y) < r);
        task.auto = () => [...alive].forEach(kill);
        task.taps = () => [...alive].map((b) => b.worldPos());
        if (which === 0) {
          // insecticide: drag the can, the spray cloud kills what it touches
          const spray = this.item(c.m_Insecticide);
          void this.runHolder(c.m_OnSelectInsecticide);
          if (!spray) return null;
          task.items = [spray];
          this.every(() => {
            if (task.done) return true;
            if (this.drag?.item === spray) for (const b of near(this.toolPoint(spray), 1.1)) kill(b);
            return false;
          });
          task.goals = () => [...alive].map((b) => b.worldPos());
        } else {
          // slipper / fly swatter: tap a bug, the tool slaps down there
          const tool = this.gosOf(which === 1 ? c.m_SlipperOBJ : c.m_FlySwatterOBJ)[0];
          const animGo = this.scene.get((which === 1 ? c.m_SlipperAnim : c.m_FlySwatterAnim) as Ref);
          let busy = false;
          task.onTap = (p) => {
            if (busy || !near(p, 1.2).length) return;
            busy = true;
            if (tool) {
              tool.setActive(true);
              tool.setWorldPos(p.x, p.y);
            }
            const sp = animGo?.spine;
            const name = sp ? (sp.skeleton.data.findAnimation('slipper') ?? sp.skeleton.data.animations[0])?.name : undefined;
            if (sp && name) sp.state.setAnimation(0, name, false);
            void this.sleep(0.22).then(() => {
              play(smash);
              this.fx.burst('dust', p.x, p.y, 10, 0.6);
              for (const b of near(p, 1.0)) kill(b);
            });
            void this.sleep(0.7).then(() => {
              tool?.setActive(false);
              busy = false;
            });
          };
        }
        return task;
      }
      case 'DragObjectMulti':
      case 'DragObjectMulti2':
      case 'DragObjectMultiInOrder': {
        const items = this.gosOf(c.m_ListDragItem).filter((o) => o.activeInHierarchy);
        const slots = this.gosOf(c.m_ListSlot);
        if (!items.length || !slots.length) return null;
        const need = Math.min(items.length, num(c.m_MinRequireItems, 0) || Math.min(items.length, slots.length));
        const used = new Set<GO>();
        const eachHolder = g.children.find((o) => o.name === 'TweenOnDoneEach');
        const eachList = this.gosOf(c.m_ListDoneDragEachItem);
        // DragObjectMultiDragItem: each piece knows which slots take it and what happens when it lands
        const piece = (it: GO) => it.comp('DragObjectMultiDragItem');
        const slotIndex = (sl: GO) => num(sl.comp('DragObjectMultiTargetSlot')?.m_SlotIndex);
        const accepts = (it: GO, sl: GO) => {
          const acc = piece(it)?.m_AcceptSlot as number[] | undefined;
          return !acc?.length || acc.includes(slotIndex(sl));
        };
        task.items = items;
        task.progress = () => (items.length - task.items.length) / Math.max(1, need);
        task.onGrab = (it) => {
          void this.runHolder(c.m_TweenStartDragHolder);
          void this.runHolder(piece(it)?.m_TweenOnStartDragHolder);
          this.runRefs(piece(it)?.m_ListTweenOnStartDrag);
        };
        task.onRelease = (it) => {
          void this.runHolder(c.m_TweenEndDragHolder);
          const pc = piece(it);
          const reuse = items.length > slots.length;
          const slot = slots.find((sl) => (reuse || !used.has(sl)) && accepts(it, sl) && this.overlap(it, sl, 0.8));
          if (!slot) {
            void this.runHolder(pc?.m_TweenOnEndDragHolder);
            this.runRefs(pc?.m_ListTweenOnEndDrag);
            return false;
          }
          if (!reuse) used.add(slot);
          task.items = task.items.filter((o) => o !== it);
          void this.runHolder(slot.comp('DragObjectMultiTargetSlot')?.m_TweenOnDropHolder);
          if (pc) {
            // the piece takes its place (its holder shows the finished part and hides the piece)
            const snap = pc.m_SnapOnSlot ? this.moveTo(it, slot.worldPos(), 0.15) : Promise.resolve(true);
            void snap.then(() => {
              void this.runHolder(pc.m_TweenOnDoneHolder);
              this.runRefs(pc.m_ListTweenOnDone);
              if (pc.m_HideOnDone || pc.m_DisableOnDone) it.setActive(false);
              const p = it.worldPos();
              this.fx.burst('dust', p.x, p.y, 8, 0.6);
            });
          } else void this.moveTo(it, slot.worldPos(), 0.2);
          if (eachHolder) void this.runList(eachHolder.children);
          // the n-th item placed plays the n-th holder
          const nth = eachList[items.length - task.items.length - 1];
          if (nth) void this.runList(nth.children);
          if (items.length - task.items.length >= need) {
            void this.sleep(num(c.waitBetweenDoneDrag, 0.3)).then(async () => {
              await this.runHolder(c.m_TweenDoneDragHolder);
              task.finish();
            });
          }
          return true;
        };
        task.goals = () => {
          const it = task.items.find((i) => i.activeInHierarchy);
          const sl = slots.find((x) => (!used.has(x) || items.length > slots.length) && (!it || accepts(it, x))) ?? slots[0];
          return [this.centre(sl)];
        };
        return task;
      }
      case 'ScoopAndPourObject': {
        const target = this.item(c.m_TargetCollider);
        const tool = g.parent ? descendants(g.parent).find((o) => o.comps().some((x) => 'm_DragCollider' in x && x !== c)) : undefined;
        if (!tool || !target) return null;
        task.items = [tool];
        task.onRelease = (m) => {
          if (!this.overlap(m, target, 0.8)) return false;
          void this.runHolder(c.m_TweenScoop).then(() => this.runHolder(c.m_TweenPour));
          task.finish();
          return false;
        };
        task.goals = () => at(target);
        return task;
      }
      case 'HoldAndMoveIn': {
        const it = this.item(c.m_Dragitem);
        const area = this.item(c.m_DragCollider);
        if (!it) return null;
        const need = num(c.m_ProgressTime, 3);
        let t = 0;
        let last: Point | null = null;
        let working = false;
        task.items = [it];
        task.progress = () => t / need;
        task.onRelease = () => {
          if (working) this.runRefs(c.m_ListTweenOnEndProgress);
          working = false;
          return false;
        };
        task.onMove = (m) => {
          const p = this.toolPoint(m);
          if (last && Math.hypot(p.x - last.x, p.y - last.y) > 0.01 && (!area || this.overlap(m, area))) {
            t += 1 / 30;
            if (!working) {
              working = true;
              this.runRefs(c.m_ListTweenOnStartProgress);
            }
          }
          last = p;
          // the wet / dirty layer fades as the dryer works
          const prog = (c.m_CookingProgress as Ref)?.go;
          for (const f of this.fadeByCooking) if (f.progress === prog) for (const sgo of f.sprites) if (sgo.sprite) sgo.sprite.alpha = f.a0 + (f.a1 - f.a0) * Math.min(1, t / need);
          if (t >= need) {
            if (working) this.runRefs(c.m_ListTweenOnEndProgress);
            working = false;
            this.runRefs(c.m_ListTweenOnDoneProgress);
            task.finish();
          }
        };
        task.goals = () => {
          const c0 = (area ?? it).worldPos();
          return Array.from({ length: Math.ceil(need * 30) + 4 }, (_, i) => new Point(c0.x + Math.sin(i) * 0.5, c0.y + Math.cos(i * 1.3) * 0.5));
        };
        return task;
      }
      case 'HoldToDoStuffObject':
      case 'HoldToDoStuffWithTimerObject':
      case 'ClickHold':
      case 'PressWithAnimationObject': {
        const area = this.item(c.m_TouchArea) ?? g;
        const sp = this.scene.get(c.m_Animation as Ref)?.spine;
        const anim = c.m_AnimationName as string | undefined;
        const end = num(c.endTime, 0) || (sp && anim ? sp.skeleton.data.findAnimation(anim)?.duration ?? 2 : 2);
        const clip = (c.m_SoundClip as { audio?: string } | undefined)?.audio;
        const ps = this.scene.get(c.m_ParticleSystem as Ref);
        const progHolder = this.scene.get(c.m_TweenOnHoldProgress as Ref);
        const movers = progHolder ? progHolder.children.flatMap((o) => o.comps().filter((x) => x.t === 'ObjectProgressMover')) : [];
        const stopPs = () => {
          if (ps && c.m_StopParticleOnEnd) for (const e of withChildren(ps, this.emitters)) e.stop();
        };
        let t = 0;
        let voice: Voice | null = null;
        let started = false;
        task.progress = () => t / end;
        task.onHold = (dt) => {
          if (!started) {
            started = true;
            void this.runHolder(c.m_TweenHoldHolder);
            if (sp && anim && sp.skeleton.data.findAnimation(anim)) sp.state.setAnimation(0, anim, false);
            if (clip) voice = play(clip, { loop: true });
            if (ps) for (const e of withChildren(ps, this.emitters)) e.play();
          }
          if (sp) sp.state.timeScale = 1;
          t += dt;
          // ObjectProgressMover: the tool slides from start to end as the job progresses
          for (const pm of movers) {
            const a = this.scene.get(pm.startPlace as Ref)?.worldPos();
            const b = this.scene.get(pm.endPlace as Ref)?.worldPos();
            const o = this.scene.get(pm.objectMove as Ref);
            if (a && b && o) {
              const k = Math.min(1, t / end);
              o.setWorldPos(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k);
            }
          }
          if (t >= end) {
            voice?.stop();
            stopPs();
            this.hold = null;
            void this.runHolder(c.m_TweenEndHolder);
            task.finish();
          }
        };
        task.onHoldEnd = () => {
          if (task.done) return;
          voice?.stop();
          voice = null;
          stopPs();
          started = false;
          if (sp) sp.state.timeScale = 0;
          void this.runHolder(c.m_TweenReleaseHolder);
        };
        task.taps = () => [area.worldPos()];
        (task as Task & { holdArea?: GO }).holdArea = area;
        return task;
      }

      case 'PumpObject': {
        const pump = this.item(c.pumpItem);
        const pc = pump?.comp('PumpItem');
        const pumpSp = this.scene.get(pc?.pumpAnimation as Ref)?.spine;
        const bike = this.scene.get(c.bicycleAnimation as Ref)?.spine;
        const need = Math.max(1, num(c.pumpProgress, 10));
        const pull = (pc?.pullSound as { audio?: string } | undefined)?.audio;
        const push = (pc?.pushSound as { audio?: string } | undefined)?.audio;
        void this.runHolder(c.onStartHolder);
        let n = 0;
        let lastY: number | null = null;
        let travel = 0;
        let dir = 0;
        const stroke = () => {
          n++;
          const down = dir < 0;
          const sn = down ? push : pull;
          if (sn) play(sn);
          const anims = pumpSp?.skeleton.data.animations ?? [];
          const a = anims.find((x) => (down ? /push|down|press/i : /pull|up/i).test(x.name)) ?? anims[0];
          if (pumpSp && a) pumpSp.state.setAnimation(0, a.name, false);
          const ba = bike?.skeleton.data.animations[0];
          if (bike && ba) {
            const e = bike.state.setAnimation(0, ba.name, false);
            e.trackTime = (n / need) * ba.duration;
            e.timeScale = 0;
          }
          if (n >= need) {
            this.hold = null;
            task.finish();
          }
        };
        task.onHold = (_dt, p) => {
          if (lastY !== null) {
            const dy = p.y - lastY;
            const d = Math.sign(dy);
            if (d && d !== dir) {
              if (travel > 0.6) stroke();
              travel = 0;
              dir = d;
            }
            travel += Math.abs(dy);
          }
          lastY = p.y;
        };
        task.onHoldEnd = () => {
          if (travel > 0.6) stroke();
          lastY = null;
          travel = 0;
        };
        task.auto = () => {
          while (!task.done) {
            dir = -dir || 1;
            stroke();
          }
        };
        return task;
      }
      case 'ScrewObject': {
        const screw = this.item(c.screwTransform);
        const need = num(c.totalRotations, 3);
        const snd = (c.screwSoundPerRotation as { audio?: string } | undefined)?.audio;
        const end = (c.screwCompleteSound as { audio?: string } | undefined)?.audio;
        let turns = 0;
        let lastA: number | null = null;
        let whole = 0;
        const centre = () => (screw ? this.centre(screw) : new Point(this.scene.camX, this.scene.camY));
        const advance = (da: number) => {
          turns += Math.abs(da) / (Math.PI * 2);
          if (screw) screw.view.rotation += da;
          if (Math.floor(turns) > whole) {
            whole = Math.floor(turns);
            if (snd) play(snd);
          }
          if (turns >= need) {
            this.hold = null;
            if (end) play(end);
            void this.runHolder(c.onDoneHolder);
            task.finish();
          }
        };
        task.onHold = (_dt, p) => {
          const o = centre();
          const a = Math.atan2(p.y - o.y, p.x - o.x);
          if (lastA !== null) {
            let da = a - lastA;
            if (da > Math.PI) da -= Math.PI * 2;
            if (da < -Math.PI) da += Math.PI * 2;
            advance(da);
          }
          lastA = a;
        };
        task.onHoldEnd = () => (lastA = null);
        task.auto = () => {
          while (!task.done) advance(0.5);
        };
        return task;
      }
      case 'CarHeadlightRemover': {
        const h = this.item(c.m_Handle);
        if (!h) return null;
        const goal = num(c.m_DistanceGoal, 2);
        const snd = (c.m_SoundDrag as { audio?: string } | undefined)?.audio;
        const done = (c.m_SoundDone as { audio?: string } | undefined)?.audio;
        let voice: Voice | null = null;
        task.items = [h];
        task.onMove = (m) => {
          if (!voice && snd) voice = play(snd, { loop: true });
          if (!this.drag) return;
          const p = m.worldPos();
          if (Math.hypot(p.x - this.drag.start.x, p.y - this.drag.start.y) >= goal) {
            voice?.stop();
            this.dropDrag();
            if (done) play(done);
            void this.runHolder(c.m_TweenHolder);
            task.finish();
          }
        };
        task.onRelease = () => {
          voice?.stop();
          voice = null;
          return false;
        };
        task.goals = () => {
          const p = h.worldPos();
          return [new Point(p.x + goal + 0.5, p.y)];
        };
        return task;
      }
      case 'ScrewLightBulbHoldTween': {
        const area = this.item(c.interactionCollider);
        const sp = this.scene.get(c.skeletonAnimation as Ref)?.spine;
        const name = c.unscrewAnimName as string;
        const loops = Math.max(1, num(c.requiredLoops, 1));
        const dur = (sp && sp.skeleton.data.findAnimation(name)?.duration) || 1.2;
        let t = 0;
        let started = false;
        task.onHold = (dt) => {
          if (!started) {
            started = true;
            void this.runHolder(c.onStartScrew);
            if (sp && sp.skeleton.data.findAnimation(name)) sp.state.setAnimation(0, name, true);
          }
          if (sp) sp.state.timeScale = num(c.holdTimeScale, 1);
          t += dt * num(c.holdTimeScale, 1);
          if (t >= dur * loops) {
            this.hold = null;
            const idle = c.idleAnimName as string;
            if (sp && idle && sp.skeleton.data.findAnimation(idle)) sp.state.setAnimation(0, idle, true);
            void this.runHolder(c.onEndScrew);
            task.finish();
          }
        };
        task.onHoldEnd = () => {
          if (sp) sp.state.timeScale = 0;
        };
        task.taps = () => [area ? this.centre(area) : new Point()];
        (task as Task & { holdArea?: GO }).holdArea = area ?? undefined;
        return task;
      }
      case 'WireConnectInteractiveItem': {
        type End = { click?: Ref; hideOnConnect?: Ref[]; showOnConnect?: Ref[]; showAfterConnect?: Ref[] };
        const pairs = (c.pairs as { left: End; right: End }[]) ?? [];
        if (!pairs.length) return null;
        let i = 0;
        let half = false;
        const apply = (pr: { left: End; right: End }) => {
          for (const e of [pr.left, pr.right]) {
            for (const o of this.gosOf(e.hideOnConnect)) o.setActive(false);
            for (const o of this.gosOf(e.showOnConnect, e.showAfterConnect)) o.setActive(true);
          }
          play('Metal_Clip_Lock');
        };
        const step = (p: Point | null) => {
          const pr = pairs[i];
          if (!pr) return;
          const want = this.scene.get(half ? pr.right.click : pr.left.click);
          if (p && want && !this.contains(want, p)) return;
          if (!half) {
            half = true;
            play('Pick_Items', { volume: 0.6 });
            return;
          }
          half = false;
          apply(pr);
          i++;
          if (i >= pairs.length) void this.sleep(0.5).then(task.finish);
        };
        task.onTap = (p) => step(p);
        task.auto = () => {
          while (!task.done && i < pairs.length) step(null);
        };
        return task;
      }
      case 'DrawObject': {
        const targets = this.gosOf(c.m_ListTarget);
        const goal = num(c.m_TriggerTimeGoal, 2);
        const snd = (c.m_SoundFX_Draw as { audio?: string } | undefined)?.audio;
        const areas = targets.flatMap((t) => {
          const holder = this.item(t.comp('DrawTarget')?.m_ColHolder) ?? t;
          return [holder, ...descendants(holder)].filter((o) => o.colliders.length);
        });
        let t = 0;
        let voice: Voice | null = null;
        const finish = () => {
          voice?.stop();
          this.hold = null;
          for (const tg of targets) void this.runList(tg.children);
          task.finish();
        };
        task.onHold = (dt, p) => {
          if (areas.length && !areas.some((a) => this.contains(a, p))) return;
          if (!voice && snd) voice = play(snd, { loop: true });
          t += dt;
          if (t >= goal) finish();
        };
        task.onHoldEnd = () => {
          voice?.stop();
          voice = null;
        };
        task.auto = () => finish();
        return task;
      }
      case 'DragRotateObject': {
        const it = this.item(c.m_GO) ?? g;
        const target = this.item(c.m_TargetArea);
        if (!target) return null;
        task.items = [it];
        task.onRelease = (m) => {
          if (!this.overlap(m, target, 0.8)) return false;
          void this.moveTo(m, target.worldPos(), 0.2);
          void this.runHolder(c.m_ListTweenOnDone);
          task.finish();
          return true;
        };
        task.goals = () => [this.centre(target)];
        return task;
      }
      case 'BugKill3ToolsDrag': {
        const choices = [c.m_Tool1Choice, c.m_Tool2Choice, c.m_Tool3Choice];
        const idx = Math.max(0, this.lastChoice ? choices.findIndex((r) => isRef(r) && r.go === this.lastChoice!.id) : 0);
        const tool = this.item([c.m_Tool1, c.m_Tool2, c.m_Tool3][idx]) ?? this.item(c.m_Tool1);
        const bugs = this.gosOf(c.m_Bugs).filter((o) => o.activeInHierarchy);
        if (!tool || !bugs.length) return null;
        void this.runHolder([c.m_OnSelectTool1, c.m_OnSelectTool2, c.m_OnSelectTool3][idx]);
        const left = new Set(bugs);
        task.items = [tool];
        task.onMove = (m) => {
          for (const b of left) {
            if (!this.overlap(m, b)) continue;
            left.delete(b);
            play(/spray/i.test(m.name) ? 'Squirt' : 'Slapping', { volume: 0.7 });
            void this.tween(0.4, (k) => (b.view.alpha = 1 - k)).then(() => b.setActive(false));
          }
          if (!left.size) {
            this.dropDrag();
            void this.runHolder([c.m_OnCloseTool1, c.m_OnCloseTool2, c.m_OnCloseTool3][idx]);
            task.finish();
          }
        };
        task.goals = () => [...left].map((b) => this.centre(b));
        return task;
      }
      case 'WaitForEndMinigame': {
        const mc = this.scene.get(c.m_MatchingController as Ref);
        const items = mc ? descendants(mc).map((o) => o.comp('ItemMatching')).filter((x): x is CompData => !!x) : [];
        const byId = new Map<number, number>();
        for (const it of items) {
          const col = it.m_ColorConnection as { r?: number; g?: number; b?: number } | undefined;
          const rgb = ((Math.round((col?.r ?? 0) * 255) << 16) | (Math.round((col?.g ?? 0) * 255) << 8) | Math.round((col?.b ?? 0) * 255)) >>> 0;
          byId.set(num(it.m_ItemID), rgb);
        }
        const colors = [...byId.values()];
        if (!colors.length) return null;
        void matchPairs(this.app, colors, () => play('Pick_Items')).then(() => task.finish());
        task.auto = () => autoSolveMatch();
        return task;
      }
      default:
        console.warn('unsupported task', c.t, g.name);
        // unknown task: let a tap anywhere move the level on rather than block it
        task.onTap = () => task.finish();
        task.taps = () => [new Point(this.scene.camX, this.scene.camY)];
        return task;
    }
  }

  /** Near the end of a scrub / spray task, rings pulse on the spots still left. */
  private updateMarks(dt: number): void {
    this.markT += dt;
    if (this.markT >= 0.3 || !this.markPts.length) {
      if (this.markT >= 0.3) this.markT = 0;
      const t = this.tasks.find((x) => !x.done && x.left && x.items.some((i) => i.activeInHierarchy) && (x.progress?.() ?? 0) >= 0.6);
      this.markPts = t ? t.left!().slice(0, 4) : [];
    }
    const on = this.markPts.length > 0;
    this.markA = Math.max(0, Math.min(1, this.markA + (on ? dt : -dt) * 4));
    this.marks.clear();
    if (!this.markA || !on) return;
    const k = this.scene.world.scale.x;
    const ph = (this.time * 1.6) % 1;
    for (const p of this.markPts) {
      const r = (16 + 14 * ph) / k;
      this.marks.circle(p.x, p.y, r).stroke({ width: 3 / k, color: 0xffffff, alpha: this.markA * (1 - ph) * 0.95 });
      this.marks.circle(p.x, p.y, 7 / k).fill({ color: 0xffe066, alpha: this.markA * (0.55 + 0.35 * Math.sin(this.time * 6)) });
    }
  }

  /** The tool leaves the player's hand without a release (task done, script move): its working
   * effects (loop sounds, particles, Spine) go off as if the finger had let go. */
  private dropDrag(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.runDragList(d.item, 'm_ListTweenEndDrag');
  }

  /** After a few idle seconds, show the hand on the first thing the player can do. */
  private updateHint(dt: number): void {
    const busy = !!this.drag || !!this.hold || this.ui.busy;
    this.idle = busy ? 0 : this.idle + dt;
    if (busy || this.idle < 3) {
      if (this.hint.shown) this.hint.hide();
      return;
    }
    this.hint.update(dt, this.scene.world.scale.x);
    if (this.hint.shown) return;
    const k = this.scene.world.scale.x;
    const hw = this.app.screen.width / 2 / k;
    const hh = this.app.screen.height / 2 / k;
    // tools of tools not picked yet wait off screen: point at what the player can see
    const onScreen = (g: GO) => {
      const p = g.worldPos();
      return Math.abs(p.x - this.scene.camX) < hw && Math.abs(p.y - this.scene.camY) < hh;
    };
    for (const t of this.tasks) {
      const it = t.items.find((i) => i.activeInHierarchy && onScreen(i));
      if (it) {
        const goal = t.goals?.()[0];
        this.hint.show(this.centre(it), goal ?? null);
        return;
      }
      const tap = t.items.length ? undefined : t.taps?.()[0];
      if (tap) {
        this.hint.show(tap, null);
        return;
      }
    }
  }

  /** Index of the option last picked among a ChooseOptionItem list (0 if none). */
  private choiceIndex(items: unknown): number {
    const ids = refs(items).map((r) => r.go);
    return Math.max(0, this.lastChoice ? ids.indexOf(this.lastChoice.id) : 0);
  }

  /** ClickToBreakTool (hammers): bring the tool onto a ClickToBreakItem (drag it there or tap
   * the item) and it strikes with its Spine animation; each "hit" event cracks the item one
   * step (its TweenOnHits), until every item is broken. */
  private breakTask(task: Task, tool: GO | undefined, targets: GO[], done: () => Promise<void>): Task | null {
    if (!targets.length) return null;
    const ct = tool?.comp('ClickToBreakTool');
    if (!tool || !ct) return this.tapTask(task, targets, 3, done);
    const left = new Map(targets.map((o) => [o, num(o.comp('ClickToBreakItem')?.m_TotalHit, 1)]));
    const totalHits = [...left.values()].reduce((a, b) => a + b, 0);
    task.progress = () => 1 - [...left.values()].reduce((a, b) => a + b, 0) / Math.max(1, totalHits);
    const animGo = this.scene.get(ct.m_AnimTool as Ref);
    const idle = this.scene.get(ct.m_IdleState as Ref);
    const smash = this.scene.get(ct.m_ColSmash as Ref) ?? tool;
    const anim = ct.m_AnimName as string;
    const evName = (ct.m_EventName as string) || 'hit';
    const snd = (ct.m_SoundSmash as { audio?: string } | undefined)?.audio ?? 'Hammer_Wood';
    // a big hammer cracks several steps per strike (hit_point), a small one a single step
    const power = Math.max(1, num(ct.hit_point, 1));
    let busy = false;
    let busyAt = 0;
    const hitOn = (o: GO) => {
      const n = left.get(o);
      if (n === undefined) return;
      const cb = o.comp('ClickToBreakItem');
      const total = num(cb?.m_TotalHit, 1);
      const steps = refs(cb?.m_TweenOnHits);
      const k = Math.min(n, power);
      // every crack the strike passes through plays, so the item ends in its last state
      for (let j = 0; j < k; j++) void this.runHolder(steps[total - n + j]);
      play(snd, { volume: 0.9 });
      const p = this.centre(o);
      this.fx.burst('chip', p.x, p.y, 10 + 4 * k, 0.7);
      if (n > k) left.set(o, n - k);
      else {
        left.delete(o);
        if (!left.size) void this.sleep(0.5).then(done).then(() => task.finish());
      }
    };
    const strike = (o: GO) => {
      busy = true;
      busyAt = this.time;
      const sp = animGo?.spine;
      if (animGo && sp && sp.skeleton.data.findAnimation(anim)) {
        animGo.setActive(true);
        idle?.setActive(false);
        sp.state.timeScale = num(ct.m_TimeScale, 1);
        let hit = false;
        const e = sp.state.setAnimation(0, anim, false);
        e.listener = {
          event: (_t, ev) => {
            if (!hit && ev.data.name === evName) {
              hit = true;
              hitOn(o);
            }
          },
          complete: () => {
            if (!hit) hitOn(o);
            animGo.setActive(false);
            idle?.setActive(true);
            busy = false;
          },
        };
      } else {
        hitOn(o);
        void this.sleep(0.35).then(() => (busy = false));
      }
    };
    task.items = [tool];
    // keep striking while the tool rests on an item
    this.every(() => {
      if (task.done) return true;
      // a strike whose animation was cut (tool hidden mid-swing) must not lock the hammer
      if (busy && this.time - busyAt > 3) {
        busy = false;
        animGo?.setActive(false);
        idle?.setActive(true);
      }
      if (!busy && this.drag?.item === tool) {
        const o = [...left.keys()].find((x) => x.activeInHierarchy && this.overlap(smash, x, 0.3));
        if (o) strike(o);
      }
      return false;
    });
    task.onTap = (p) => {
      if (busy || !tool.activeInHierarchy) return;
      const o = [...left.keys()].find((x) => this.contains(x, p));
      if (!o) return;
      const sp = this.toolPoint(smash);
      const tp = tool.worldPos();
      tool.setWorldPos(p.x - (sp.x - tp.x), p.y - (sp.y - tp.y));
      strike(o);
    };
    task.goals = () => [...left.keys()].map((o) => this.centre(o));
    task.auto = () => {
      for (const o of [...left.keys()]) while (left.has(o)) hitOn(o);
    };
    return task;
  }

  /** Tap each target `hits` times; then `done` runs and the task ends. */
  private tapTask(task: Task, targets: GO[], hits: number, done: () => Promise<void>, onBreak?: (o: GO) => void): Task | null {
    if (!targets.length) return null;
    const left = new Map(targets.map((o) => [o, num(o.comp('ClickToBreakItem')?.m_TotalHit, hits)]));
    task.onTap = (p) => {
      for (const [o, n] of left) {
        if (!o.activeInHierarchy || !this.contains(o, p)) continue;
        const cb = o.comp('ClickToBreakItem');
        if (cb) {
          const total = num(cb.m_TotalHit, hits);
          void this.runHolder(refs(cb.m_TweenOnHits)[total - n]);
          this.fx.burst('dust', p.x, p.y, 10, 0.6);
          play('Hammer_Wood', { volume: 0.8 });
          if (n > 1) left.set(o, n - 1);
          else left.delete(o);
          break;
        }
        if (n > 1) {
          left.set(o, n - 1);
          play('Take_Item_1', { volume: 0.7 });
          void this.tween(0.12, (k) => o.view.scale.set(o.view.scale.x * (1 - 0.04 * Math.sin(k * Math.PI)), o.view.scale.y));
        } else {
          left.delete(o);
          onBreak?.(o);
          if (!onBreak) void this.runList(o.children);
        }
        break;
      }
      if (!left.size) void done().then(() => task.finish());
    };
    task.taps = () =>
      [...left.keys()].map((o) => {
        const r = this.rect(o);
        return this.scene.world.toLocal(new Point(r.x + r.width / 2, r.y + r.height / 2));
      });
    return task;
  }

  /** World-space centre of a GameObject's collider (or drawing). */
  centre(g: GO): Point {
    const r = this.rect(g);
    return this.scene.world.toLocal(new Point(r.x + r.width / 2, r.y + r.height / 2));
  }

  private contains(g: GO, p: Point): boolean {
    const r = this.rect(g);
    const q = this.scene.world.toGlobal(p);
    const pad = 16;
    return q.x >= r.x - pad && q.x <= r.x + r.width + pad && q.y >= r.y - pad && q.y <= r.y + r.height + pad;
  }

  // ---- input ----------------------------------------------------------------

  pointerDown(x: number, y: number): void {
    this.idle = 0;
    this.hint.hide();
    if (this.ui.busy || this.ui.onBar(x, y)) return;
    const p = this.scene.toWorld(x, y);
    let best: { it: GO; task: Task } | null = null;
    for (const t of this.tasks)
      for (const it of t.items) {
        if (!it.activeInHierarchy || !this.hit(it, x, y)) continue;
        if (!best || this.top(it) > this.top(best.it)) best = { it, task: t };
      }
    if (!best) {
      for (const t of [...this.tasks]) {
        const area = (t as Task & { holdArea?: GO }).holdArea;
        if (t.onHold && (!area || this.contains(area, p))) {
          this.hold = { task: t, p };
          return;
        }
      }
      for (const t of [...this.tasks]) t.onTap?.(p);
      if (this.camZone) this.pan = { x, y, cx: this.scene.camX, cy: this.scene.camY };
      return;
    }
    const ip = best.it.worldPos();
    this.moveGen.set(best.it.id, (this.moveGen.get(best.it.id) ?? 0) + 1);
    this.drag = { item: best.it, task: best.task, grab: new Point(ip.x - p.x, ip.y - p.y), start: ip, moved: 0 };
    this.runDragList(best.it, 'm_ListTweenStartDrag');
    for (const t of this.tasks) if (t.items.includes(best.it)) t.onGrab?.(best.it);
    play('Pick_Items', { volume: 0.6 });
  }

  pointerMove(x: number, y: number): void {
    if (this.hold) this.hold.p = this.scene.toWorld(x, y);
    if (this.pan && this.camZone) {
      const k = this.scene.world.scale.x;
      const lim = this.camLimits();
      if (this.camZone.h) this.scene.camX = clamp(this.pan.cx - (x - this.pan.x) / k, lim.x0, lim.x1);
      if (this.camZone.v) this.scene.camY = clamp(this.pan.cy + (y - this.pan.y) / k, lim.y0, lim.y1);
      this.relayout();
    }
    if (!this.drag) return;
    const p = this.scene.toWorld(x, y);
    const before = this.drag.item.worldPos();
    this.drag.item.setWorldPos(p.x + this.drag.grab.x, p.y + this.drag.grab.y);
    this.drag.moved++;
    const after = this.drag.item.worldPos();
    if (Math.hypot(after.x - before.x, after.y - before.y) > 0.01) this.toolWorking();
    // every task using this item hears about the move (e.g. a sponge that fills slots and scrubs)
    const it = this.drag.item;
    for (const t of [...this.tasks]) if (!t.done && t.items.includes(it)) t.onMove?.(it);
    // dragging a tool to the screen edge slides the camera along
    if (this.camZone?.h) {
      const w = this.app.screen.width;
      const edge = x < 40 ? -1 : x > w - 40 ? 1 : 0;
      if (edge) {
        const lim = this.camLimits();
        this.scene.camX = clamp(this.scene.camX + edge * 0.08, lim.x0, lim.x1);
        this.relayout();
      }
    }
  }

  /** How far the camera may pan: the confiner/zone collider, else the level's drawing. */
  private camLimits(): { x0: number; x1: number; y0: number; y1: number } {
    const zone = this.scene.gos.find((g) => (g.comp('CinemachineConfiner2D') || g.comp('CamLimitedZone')) && g.colliders.length);
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const k = this.scene.world.scale.x;
    const r = zone ? this.rect(zone) : this.scene.world.getBounds().rectangle;
    const a = this.scene.world.toLocal(new Point(r.x, r.y + r.height));
    const b = this.scene.world.toLocal(new Point(r.x + r.width, r.y));
    const hw = w / 2 / k;
    const hh = h / 2 / k;
    return { x0: Math.min(a.x + hw, b.x - hw), x1: Math.max(a.x + hw, b.x - hw), y0: Math.min(a.y + hh, b.y - hh), y1: Math.max(a.y + hh, b.y - hh) };
  }

  /** A tool's own start/end-drag actions: its spray, sounds, animations. */
  private dragVoice: Voice | null = null;
  private dragSound: string | null = null;
  private workedAt = -1;
  /** the playing work sound is a stand-in scrub sound: it only plays while the tool rubs */
  private dragFallback = false;
  private fallbackAt = -1;

  /** The held tool is doing its job this frame: its working sound is on. */
  private toolWorking(fallback?: string): void {
    this.workedAt = this.time;
    if (fallback) this.fallbackAt = this.time;
    const snd = this.dragSound ?? fallback;
    if (!this.dragVoice && snd && this.drag) {
      this.dragVoice = play(snd, { loop: true, volume: 0.8 });
      this.dragFallback = !this.dragSound;
    }
  }

  /** Every running loop off (level end). */
  stopSounds(): void {
    for (const v of this.voices.values()) v.stop(0.2);
    this.voices.clear();
    this.dragVoice?.stop(0.2);
    this.dragVoice = null;
    this.dragSound = null;
  }

  private toolBase = new Map<GO, number>();

  /** How the original DraggableItem looks while held: tilt, Spine loop, sounds, particle. */
  private toolLook(it: GO, di: CompData | undefined, start: boolean): void {
    if (!di) return;
    const angle = num(di.m_RotateAngle);
    if (angle) {
      if (!this.toolBase.has(it)) this.toolBase.set(it, it.view.rotation);
      const r0 = it.view.rotation;
      const r1 = this.toolBase.get(it)! + (start ? (angle * Math.PI) / 180 : 0);
      void this.tween(num(di.m_RotateTime, 0.2), (k) => (it.view.rotation = r0 + (r1 - r0) * k));
    }
    // a hammer (ClickToBreakTool) plays its strike itself, in time with the hits (breakTask)
    const spGo = it.comp('ClickToBreakTool') ? undefined : (this.scene.get(di.m_SkeletonAnimation as Ref) ?? this.gosOf(di.m_ListAnimRender).find((g) => g.spine));
    const sp = spGo?.spine;
    if (sp) {
      const name = (di.m_AnimName as string) || sp.skeleton.data.animations[0]?.name;
      if (start && name && sp.skeleton.data.findAnimation(name)) {
        sp.state.timeScale = 1;
        sp.state.setAnimation(0, name, di.isLoopAnimSpine !== 0);
      } else if (!start) sp.state.timeScale = 0;
    }
    const once = ((start ? di.m_AudioOnStartDrag : di.m_AudioOnEndDrag) as { audio?: string } | undefined)?.audio;
    if (once) play(once);
    const ps = this.scene.get(di.particle as Ref);
    if (ps && di.playParticle) for (const e of withChildren(ps, this.emitters)) (start ? e.play() : e.stop());
  }

  private runDragList(it: GO, field: 'm_ListTweenStartDrag' | 'm_ListTweenEndDrag'): void {
    const di = it.comps().find((x) => field in x);
    const start = field === 'm_ListTweenStartDrag';
    this.toolLook(it, di, start);
    // the tool's own working sound (sponge, spray, clipper motor...) plays while the tool is
    // moved, and stops when the finger rests or lets go (see toolWorking / update)
    this.dragVoice?.stop(0.12);
    this.dragVoice = null;
    this.dragSound = start ? ((di?.m_Audio as { audio?: string } | undefined)?.audio ?? null) : null;
    // tools without lists switch their own child effects on/off (PlayParticle / StopParticleForce)
    if (!refs(di?.[field]).length) {
      for (const ch of it.children)
        for (const c of ch.comps())
          if (start ? c.t === 'PlayParticle' || (c.t === 'PlayAudio' && c.LOOP) : c.t === 'StopParticleForce' || c.t === 'StopSoundLoop') void this.action(ch, c);
      return;
    }
    const done = new Set<GO>();
    for (const r of refs(di?.[field])) {
      const g = this.scene.get(r);
      const c = this.scene.compOf(r);
      if (!g) continue;
      // the list names the first action of a holder (Start / End): run the whole holder
      const holder = g.parent && !g.parent.comps().length ? g.parent : null;
      if (holder && /start|end|drag/i.test(holder.name)) {
        if (!done.has(holder)) {
          done.add(holder);
          void this.runList(holder.children);
        }
      } else if (c && 'm_TweenChecker' in c) void this.action(g, c);
      else void this.runList([g]);
    }
  }

  pointerUp(): void {
    this.pan = null;
    if (this.hold) {
      this.hold.task.onHoldEnd?.();
      this.hold = null;
    }
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.runDragList(d.item, 'm_ListTweenEndDrag');
    let used = false;
    for (const t of [...this.tasks]) if (!t.done && t.items.includes(d.item)) used = (t.onRelease?.(d.item) ?? false) || used;
    if (!used && d.item.activeInHierarchy) {
      const di = d.item.comps().find((x) => 'm_ListTweenOnDoneSnapToBasePos' in x);
      void this.moveTo(d.item, d.start, num(di?.returnDuration, 0.3), true).then((ok) => ok && this.runRefs(di?.m_ListTweenOnDoneSnapToBasePos));
    }
  }

  // ---- geometry -------------------------------------------------------------

  private top(g: GO): number {
    let k = g.sortKey;
    for (const ch of g.children) k = Math.max(k, this.top(ch));
    return k;
  }

  private hit(g: GO, x: number, y: number): boolean {
    const pad = 12;
    const inside = (b: { x: number; y: number; width: number; height: number }) =>
      b.width + b.height > 0 && x >= b.x - pad && x <= b.x + b.width + pad && y >= b.y - pad && y <= b.y + b.height + pad;
    // its drawing, or its drag collider (a towel shown by another sprite until picked up)
    return inside(g.view.getBounds()) || inside(this.rect(dragColliderOf(g)));
  }

  /** Global-px rect of a GameObject's colliders (or its drawing if it has none). */
  private rect(g: GO): Rectangle {
    const own = colliderGO(g);
    if (own) {
      const col = own.colliders.find((k) => k.kind === 'box') ?? own.colliders[0];
      if (col && col.kind === 'box') {
        const [ox, oy] = col.offset ?? [0, 0];
        const [w, h] = col.size ?? [1, 1];
        const pts = [
          [ox - w / 2, oy - h / 2],
          [ox + w / 2, oy - h / 2],
          [ox + w / 2, oy + h / 2],
          [ox - w / 2, oy + h / 2],
        ].map(([px, py]) => own.view.toGlobal(new Point(px, py)));
        const xs = pts.map((q) => q.x);
        const ys = pts.map((q) => q.y);
        return new Rectangle(Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      }
      if (col && col.kind === 'poly' && col.paths?.length) {
        const [ox, oy] = col.offset ?? [0, 0];
        const pts = col.paths.flat().map(([px, py]) => own.view.toGlobal(new Point(px + ox, py + oy)));
        const xs = pts.map((q) => q.x);
        const ys = pts.map((q) => q.y);
        return new Rectangle(Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      }
      if (col && col.kind === 'circle') {
        const c0 = own.view.toGlobal(new Point(col.offset?.[0] ?? 0, col.offset?.[1] ?? 0));
        const c1 = own.view.toGlobal(new Point((col.offset?.[0] ?? 0) + col.radius, col.offset?.[1] ?? 0));
        const r = Math.hypot(c1.x - c0.x, c1.y - c0.y);
        return new Rectangle(c0.x - r, c0.y - r, r * 2, r * 2);
      }
    }
    return g.view.getBounds().rectangle;
  }

  overlap(a: GO, b: GO, shrink = 1): boolean {
    let ra = this.rect(dragColliderOf(a));
    if (ra.width === 0 && ra.height === 0) ra = this.rect(a);
    const rb = this.rect(b);
    if (shrink !== 1) {
      const cx = rb.x + rb.width / 2;
      const cy = rb.y + rb.height / 2;
      rb.width *= shrink + 0.4;
      rb.height *= shrink + 0.4;
      rb.x = cx - rb.width / 2;
      rb.y = cy - rb.height / 2;
    }
    return ra.x < rb.x + rb.width && ra.x + ra.width > rb.x && ra.y < rb.y + rb.height && ra.y + ra.height > rb.y;
  }

  /** Where a tool works (its drag collider's centre), in world units. */
  toolPoint(g: GO): Point {
    let r = this.rect(dragColliderOf(g));
    if (r.width === 0 && r.height === 0) r = this.rect(g);
    return this.scene.world.toLocal(new Point(r.x + r.width / 2, r.y + r.height / 2));
  }

  /** For auto-play/debug: the current tasks. */
  debugTasks(): { items: string[]; kind: string }[] {
    return this.tasks.map((t) => ({ items: t.items.map((i) => i.name), kind: t.kind ?? '' }));
  }

  /** Debug: play the current tasks like a player would (drag to targets, scrub cards). */
  autoStep(): void {
    if (this.ui.busy) {
      this.ui.pickFirst();
      return;
    }
    for (const t of [...this.tasks]) {
      if (t.auto && !t.done) {
        t.auto();
        continue;
      }
      if (t.onHold && !t.done) {
        for (let i = 0; i < 400 && !t.done; i++) t.onHold(0.05, t.taps?.()[0] ?? new Point());
        continue;
      }
      if (t.onTap && !t.items.length) {
        for (const p of t.taps?.() ?? []) if (!t.done) for (let i = 0; i < 4 && !t.done; i++) t.onTap(p);
        continue;
      }
      const it = t.items.find((i) => i.activeInHierarchy);
      if (!it) continue;
      const start = it.worldPos();
      this.drag = { item: it, task: t, grab: new Point(), start, moved: 0 };
      for (const goal of t.goals?.() ?? []) {
        const tp = this.toolPoint(it);
        const ip = it.worldPos();
        it.setWorldPos(goal.x - (tp.x - ip.x), goal.y - (tp.y - ip.y));
        t.onMove?.(it);
        if (t.done) break;
      }
      if (!t.done && this.drag) {
        const used = t.onRelease?.(it) ?? false;
        this.drag = null;
        if (!used) it.setWorldPos(start.x, start.y);
      }
      this.drag = null;
    }
  }
}

/** Interactive tasks hold the step; every one of them has an m_IsDone flag. */
function isTask(c: CompData): boolean {
  // DrawTarget only marks where a DrawObject is drawn
  return c.t !== 'DrawTarget' && (INTERACTIVE.has(c.t) || 'm_IsDone' in c);
}

function descendants(g: GO): GO[] {
  const out: GO[] = [];
  const stack = [...g.children];
  while (stack.length) {
    const o = stack.shift()!;
    out.push(o);
    stack.push(...o.children);
  }
  return out;
}

function key(r: Ref): string {
  return `${r.go}:${r.comp ?? -1}`;
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/** The GameObject whose collider stands for g (g itself or a child named Collider). */
function colliderGO(g: GO): GO | null {
  if (g.colliders.length) return g;
  for (const ch of g.children) if (ch.colliders.length && /collider|col\b/i.test(ch.name)) return ch;
  return null;
}

/** A draggable's own collider (DraggableItem.m_DragCollider) if it names one. */
function dragColliderOf(g: GO): GO {
  const di = g.comps().find((c) => 'm_DragCollider' in c);
  const r = di?.m_DragCollider as Ref | undefined;
  if (r) return g.scene.get(r) ?? g;
  return g;
}
