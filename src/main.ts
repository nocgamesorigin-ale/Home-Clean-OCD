// Boot: home (chapters + story), room view (?room=Kitchen) or a level (?level=L_Sink).
// ?debug=1 exposes `rt` and `scene` on window; ?auto=1 plays the level by itself.
import { Application, Container, Graphics, Text } from 'pixi.js';
import { openCheat } from './cheat';
import { emit, levelChanged, registerLevels } from './gamekit';
import { preloadAudio, unlockAudio } from './engine/audio';
import { Runtime } from './engine/runtime';
import { Scene } from './engine/scene';
import type { LevelData, SpriteMeta } from './engine/types';
import { chapterOf, progress, ROOM_VI, showHome, showStory, type Chapter } from './home';
import { saveChoice, showRoom } from './room';

const BASE = import.meta.env.BASE_URL + 'data/';
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

async function json<T>(path: string): Promise<T> {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(path);
  return (await r.json()) as T;
}

interface Mapping {
  chapters: { chapterNamecode: string; chapterFilename: string; levels: { levelName: string; levelFilename: string; levelNamecode: string }[] }[];
}

/** Safe-area insets (notch, home bar) in CSS px, read from env() through a probe. */
export function safeArea(): { top: number; bottom: number } {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const out = { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };
  probe.remove();
  return out;
}

function loading(on: boolean): void {
  let el = document.getElementById('loading');
  if (on && !el) {
    el = document.createElement('div');
    el.id = 'loading';
    el.innerHTML = `<img src="${BASE}story/Logo.webp" alt=""><div class="spin"></div><p>Đang tải…</p>`;
    document.body.appendChild(el);
  } else if (!on) el?.remove();
}

function cheatButton(onClick: () => void): void {
  const b = document.createElement('button');
  b.className = 'cheat-btn';
  b.textContent = '🛠';
  b.setAttribute('aria-label', 'Cheat test');
  b.addEventListener('click', onClick);
  document.body.appendChild(b);
}

async function boot(): Promise<void> {
  // iOS: no pinch / double-tap zoom, no long-press callout inside the game
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  const [mapping, available] = await Promise.all([json<Mapping>('LevelMappings.json'), json<string[]>('levels/index.json').catch(() => ['L_Sink'])]);
  const chapters: Chapter[] = mapping.chapters
    .map((c) => ({ code: c.chapterNamecode, levels: c.levels.filter((l) => available.includes(l.levelFilename)).map((l) => ({ file: l.levelFilename, name: l.levelName })) }))
    .filter((c) => c.levels.length);
  const params = new URLSearchParams(location.search);
  const file = params.get('level');
  const room = params.get('room');

  // GameKit preview: every object (level) in play order; picking one opens it directly
  const order = chapters.flatMap((c) => c.levels.map((l) => ({ ...l, room: c.code })));
  const current = Math.max(0, order.findIndex((l) => l.file === file));
  registerLevels({
    count: order.length,
    names: order.map((l) => `${ROOM_VI[l.room] ?? l.room} · ${l.name}`),
    current: () => current + 1,
    goTo: (n) => {
      const next = order[Math.max(0, Math.min(order.length, n) - 1)];
      if (next && next.file !== file) location.search = `?level=${encodeURIComponent(next.file)}`;
    },
    settleMs: 2500,
  });

  if (!file && !room) {
    showHome(chapters, () => openCheat(chapters));
    return;
  }

  const app = new Application();
  await app.init({ resizeTo: window, background: '#1d1b22', antialias: true, resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: true });
  document.getElementById('app')!.appendChild(app.canvas);
  loading(true);
  const [spriteMeta, spineMeta, layers] = await Promise.all([
    json<Record<string, SpriteMeta>>('sprites/meta.json'),
    json<Record<string, { scale: number }>>('spine/meta.json'),
    json<{ id: number }[]>('sorting_layers.json'),
  ]);

  if (room) {
    const ch = chapters.find((c) => c.code === room);
    const ovFile = mapping.chapters.find((c) => c.chapterNamecode === room)?.chapterFilename;
    const [ov, objects] = await Promise.all([ovFile ? json<LevelData>(`levels/${ovFile}.json`).catch(() => null) : null, json<Record<string, string>>('levels/objects.json').catch(() => ({}))]);
    loading(false);
    const levelOf = Object.fromEntries(mapping.chapters.flatMap((c) => c.levels.map((l) => [l.levelNamecode, l.levelFilename])));
    // rooms without an overview prefab (Pool) use the chapter's before / after pictures
    const isOverview = !!ov?.nodes[0]?.comps.some((c) => c?.t === 'OverviewLevel');
    if (ch) await showRoom({ app, ch, chapters, overview: isOverview ? ov : null, objects, levelOf, spriteMeta, spineMeta, layers, fresh: params.get('fresh') });
    else location.href = './';
    cheatButton(() => openCheat(chapters));
    return;
  }

  const lv = file!;
  const ch = chapterOf(chapters, lv);
  const info = order.find((l) => l.file === lv);
  levelChanged(current + 1);
  homeButton(ch?.code);

  const level = await json<LevelData>(`levels/${lv}.json`);
  // every clip the level uses, fetched and decoded now so sounds come right with the action
  const clips = new Set(['Pick_Items', 'Item_Drop', 'Squirt', 'Slapping', 'Take_Item_1', 'Success_Long', 'Success_Magic', 'Hammer_Wood', 'Rubbing', 'Sweeping']);
  for (const m of JSON.stringify(level).matchAll(/"audio":\s*"([^"]+)"/g)) clips.add(m[1]);
  preloadAudio(clips);
  const scene = new Scene(level, layers);
  scene.spriteMetaOf = (k) => spriteMeta[k];
  await scene.build(spriteMeta, spineMeta);
  app.stage.addChild(scene.root);
  loading(false);

  // first level of a chapter never played: its opening story
  const auto = !!params.get('auto') || !!params.get('debug');
  if (ch && !auto && !progress.seen().has(ch.code + ':op')) {
    progress.markSeen(ch.code + ':op');
    await showStory(ch.code, 'op');
  }

  const rt = new Runtime(scene, app);
  rt.onChoice = (obj, opt) => saveChoice(obj, opt);
  const hud = new Hud(app, info ? `${ROOM_VI[info.room] ?? info.room} · ${info.name}` : lv);
  rt.onStep = (n, i, total) => {
    hud.setStep(i, total);
    emit('step', { level: current + 1, step: n, index: i + 1, total });
  };
  const fit = () => {
    scene.layout(app.screen.width, app.screen.height);
    hud.layout();
  };
  fit();
  app.renderer.on('resize', fit);
  let autoT = 0;
  app.ticker.add((t) => {
    const dt = Math.min(0.05, t.deltaMS / 1000);
    rt.update(dt);
    hud.update(dt, rt.stepProgress);
    // cheat: run the steps before the chosen one at high speed
    if (rt.fastForwardTo > rt.stepIndex && !rt.finished) {
      for (let i = 0; i < 30; i++) {
        rt.update(0.05);
        rt.autoStep();
        if (rt.stepIndex >= rt.fastForwardTo || rt.finished) break;
      }
    } else rt.fastForwardTo = -1;
    if (rt.autoPlay && (autoT += dt) > 0.5) {
      autoT = 0;
      rt.autoStep();
    }
    scene.layout(app.screen.width, app.screen.height);
  });

  // one finger at a time: the first pointer down owns the gesture
  const cv = app.canvas;
  let owner = -1;
  cv.addEventListener('pointerdown', (e) => {
    unlockAudio();
    if (owner !== -1) return;
    owner = e.pointerId;
    cv.setPointerCapture(e.pointerId);
    rt.pointerDown(e.offsetX, e.offsetY);
  });
  cv.addEventListener('pointermove', (e) => {
    if (e.pointerId === owner) rt.pointerMove(e.offsetX, e.offsetY);
  });
  const up = (e: PointerEvent) => {
    if (e.pointerId !== owner) return;
    owner = -1;
    rt.pointerUp();
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  // pause sounds and time when the app goes to the background
  document.addEventListener('visibilitychange', () => (document.hidden ? app.ticker.stop() : app.ticker.start()));
  cheatButton(() => openCheat(chapters, rt));

  if (params.get('debug')) Object.assign(window, { rt, scene, app });
  // ?pick=1: QA picks the 2nd option of every tool choice (each choice must be playable)
  rt.ui.debugPick = Number(params.get('pick') ?? 0) || 0;
  if (params.get('auto')) autoTest(rt, scene);

  emit('levelStart', { level: current + 1, file: lv, room: info?.room ?? '' });
  const t0 = performance.now();
  await rt.run();
  emit('win', { level: current + 1, file: lv, seconds: Math.round((performance.now() - t0) / 1000) });
  hud.setDone();
  if (!auto) progress.markDone(lv);
  // back in the room the object changes to its new look (and the room is finished there)
  hud.showDone(lv, ch?.code);
}

/** ?auto=1: plays the level at high speed and leaves a report in window.__result. */
function autoTest(rt: Runtime, scene: Scene): void {
  rt.qaOn = true;
  const warns: string[] = [];
  // drawn things that cannot show: sprites without a texture, Spines with nothing posed
  const blank = new Set<string>();
  const look = () => {
    for (const g of scene.gos) {
      if (!g.activeInHierarchy) continue;
      const sr = g.comp('SpriteRenderer');
      if (sr?.sprite && sr.enabled !== false && !g.sprite) blank.add('sprite:' + g.name);
      if (g.spine) {
        const b = g.spine.getBounds();
        if (b.width < 1 && b.height < 1) blank.add('spine:' + g.name);
      }
    }
  };
  setTimeout(look, 300);
  const warn = console.warn;
  console.warn = (...a: unknown[]) => {
    warns.push(a.map(String).join(' '));
    warn(...a);
  };
  const t0 = performance.now();
  let lastStep = '';
  let since = 0;
  const iv = setInterval(() => {
    for (let i = 0; i < 40; i++) rt.update(0.05);
    if (Math.random() < 0.1) look();
    rt.autoStep();
    if (rt.stepName !== lastStep) {
      lastStep = rt.stepName;
      since = rt.time;
    }
    const stuck = rt.time - since > 300;
    if (rt.finished || stuck || performance.now() - t0 > 90000) {
      clearInterval(iv);
      (window as unknown as { __result: unknown }).__result = {
        finished: rt.finished,
        step: rt.stepName,
        stuck,
        gameTime: Math.round(rt.time),
        nulls: rt.trace.filter((t) => t.endsWith('NULL')),
        warns: [...new Set(warns)].slice(0, 20),
        tasks: rt.debugTasks(),
        quiet: rt.stepChanges.filter((c) => c.changed === 0).map((c) => c.step),
        blank: [...blank].slice(0, 30),
        missingAnim: [...rt.qa.missingAnim].slice(0, 20),
        offscreen: [...rt.qa.offscreen].slice(0, 20),
        leftover: [...rt.qa.leftover].slice(0, 20),
        noFx: [...rt.qa.noFx].slice(0, 30),
        // Spines whose skeleton lacks animations the level plays on them (wrong skeleton file)
        spineMismatch: [...new Set(scene.gos.filter((g) => g.spine).flatMap((g) => {
          const names = new Set(g.spine!.skeleton.data.animations.map((a) => a.name));
          const miss = scene.animsUsedOn(g.id).filter((a) => !names.has(a));
          const sk = (g.comp('SkeletonAnimation')?.skeletonDataAsset as { skeleton?: string } | undefined)?.skeleton;
          return miss.length ? [`${sk}: ${miss.join('/')}`] : [];
        }))],
        fadedIn: [...rt.fadedIn].filter((g) => g.activeInHierarchy && (g.sprite?.alpha ?? 0) > 0.5).map((g) => g.name),
      };
    }
  }, 0);
}

function homeButton(room?: string): void {
  const a = document.createElement('a');
  a.href = room ? `?room=${encodeURIComponent(room)}` : './';
  a.className = 'home';
  a.setAttribute('aria-label', 'Về phòng');
  a.textContent = '⌂';
  document.body.appendChild(a);
}

/** Top-left: the object's name and the current step's progress bar (compact). */
class Hud {
  private readonly view = new Container();
  private readonly back = new Graphics();
  private readonly bar = new Graphics();
  private readonly title: Text;
  private readonly count: Text;
  /** shown / target progress of the step, and the green flash when a step is done */
  private shown = 0;
  private target = 0;
  private flash = 0;
  private step = 0;
  private total = 0;

  constructor(
    private readonly app: Application,
    name: string,
  ) {
    const shadow = { color: 0x000000, alpha: 0.6, blur: 3, distance: 1 };
    this.title = new Text({ text: name, style: { fontFamily: FONT, fontSize: 12, fontWeight: '700', fill: 0xffffff, dropShadow: shadow } });
    this.count = new Text({ text: '', style: { fontFamily: FONT, fontSize: 11, fontWeight: '700', fill: 0xffffff, dropShadow: shadow } });
    this.view.addChild(this.back, this.bar, this.title, this.count);
    app.stage.addChild(this.view);
  }

  private get barW(): number {
    return Math.max(90, Math.min(170, this.app.screen.width - 150));
  }

  layout(): void {
    const top = safeArea().top;
    const x = 12;
    const w = this.barW;
    this.title.position.set(x + 10, top + 9);
    this.count.position.set(x + 10 + w + 8, top + 25);
    this.back.clear().roundRect(x, top + 6, w + 20 + this.count.width + 8, 40, 14).fill({ color: 0x000000, alpha: 0.32 });
    this.draw();
  }

  private draw(): void {
    const top = safeArea().top;
    const x = 22;
    const w = this.barW;
    const done = this.shown >= 0.999;
    this.bar.clear();
    this.bar.roundRect(x, top + 30, w, 6, 3).fill({ color: 0xffffff, alpha: 0.28 });
    if (this.shown > 0.005) this.bar.roundRect(x, top + 30, Math.max(6, w * this.shown), 6, 3).fill(done ? 0x6fd36a : 0xf2c94c);
    if (this.flash > 0) this.bar.roundRect(x - 2, top + 28, w + 4, 10, 5).stroke({ color: 0xffffff, width: 2, alpha: this.flash });
  }

  /** A new step starts (index from 0). */
  setStep(i: number, total: number): void {
    this.step = i;
    this.total = total;
    this.shown = this.target = 0;
    this.count.text = `Bước ${i + 1}/${total}`;
    this.layout();
  }

  /** Every frame: eases the bar toward the step's progress. */
  update(dt: number, p: number): void {
    const was = this.target;
    this.target = Math.max(0, Math.min(1, p));
    if (this.target >= 1 && was < 1) this.flash = 1;
    const prev = this.shown;
    this.shown += (this.target - this.shown) * Math.min(1, dt * 10);
    if (Math.abs(this.target - this.shown) < 0.002) this.shown = this.target;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 2);
    if (prev !== this.shown || this.flash > 0) this.draw();
  }

  /** The whole object is done. */
  setDone(): void {
    if (this.total) this.count.text = `Bước ${this.total}/${this.total}`;
    this.target = this.shown = 1;
    this.layout();
  }

  showDone(level: string, room?: string): void {
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const card = new Container();
    card.addChild(new Graphics().rect(0, 0, w, h).fill({ color: 0x000000, alpha: 0.4 }));
    card.addChild(new Graphics().roundRect(w / 2 - 150, h / 2 - 120, 300, 240, 26).fill(0xffffff));
    const t = new Text({ text: 'Hoàn thành!', style: { fontFamily: FONT, fontSize: 28, fontWeight: '800', fill: 0x3a2d26 } });
    t.anchor.set(0.5);
    t.position.set(w / 2, h / 2 - 72);
    card.addChild(t);
    const button = (label: string, y: number, color: number, go: () => void) => {
      const btn = new Container();
      btn.addChild(new Graphics().roundRect(-110, -26, 220, 52, 26).fill(color));
      const bt = new Text({ text: label, style: { fontFamily: FONT, fontSize: 18, fontWeight: '700', fill: 0xffffff } });
      bt.anchor.set(0.5);
      btn.addChild(bt);
      btn.position.set(w / 2, y);
      btn.eventMode = 'static';
      btn.cursor = 'pointer';
      btn.on('pointertap', go);
      card.addChild(btn);
    };
    button(room ? 'Về căn phòng' : 'Về trang chủ', h / 2 + 30, 0x5bbf72, () => (location.search = room ? `?room=${encodeURIComponent(room)}&fresh=${encodeURIComponent(level)}` : ''));
    this.view.addChild(card);
  }
}

void boot();
