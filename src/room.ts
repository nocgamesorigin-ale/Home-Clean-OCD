// Room of a chapter: the room's own background (the original overview prefab, or the chapter
// picture when the game has none) fitted to the screen, with a round button on every object of
// the room. An object shows dirty until its level is done, then in the style the player picked;
// when every object is done the room gets its finishing touches (walls, floor, decor pickers of
// the overview's own sequence) and its ending story.
import { Assets, Container, Graphics, Point, Sprite, Texture, type Application } from 'pixi.js';
import { play, setMuted, unlockAudio } from './engine/audio';
import { Runtime } from './engine/runtime';
import { Scene, type GO } from './engine/scene';
import { isRef, type CompData, type LevelData, type Ref, type SpriteMeta } from './engine/types';
import { isOpen, progress, ROOM_VI, showStory, storyImage, type Chapter } from './home';

const DATA = import.meta.env.BASE_URL + 'data/';
const CHOICE_KEY = 'home-clean-web.choices';
const DECO_KEY = 'home-clean-web.deco';

function readMap(k: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(k) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

function writeMap(k: string, obj: string, option: string): void {
  try {
    const m = readMap(k);
    m[obj] = option;
    localStorage.setItem(k, JSON.stringify(m));
  } catch {
    /* private mode */
  }
}

/** Styles picked inside levels, per level and object ("L_Carpet|Carpet"): every pick with its
 * position in the picker and when it was made. The same object namecode is used in several rooms
 * (Floor, Table, Wall...) and some objects are picked twice (a carpet's shape, then its colour). */
const PICKS_KEY = 'home-clean-web.picks';
type Pick = { o: string; i: number; t: number };

function readPicks(): Record<string, Pick[]> {
  try {
    return JSON.parse(localStorage.getItem(PICKS_KEY) ?? '{}') as Record<string, Pick[]>;
  } catch {
    return {};
  }
}

export function saveChoice(level: string, obj: string, option: string, index: number): void {
  try {
    const m = readPicks();
    const k = `${level}|${obj}`;
    m[k] = [...(m[k] ?? []).filter((p) => p.o !== option).slice(-5), { o: option, i: Math.max(0, index), t: Date.now() }];
    localStorage.setItem(PICKS_KEY, JSON.stringify(m));
  } catch {
    /* private mode */
  }
}

/** The style to show for an object of the room: the latest pick made in its level that is one
 * of the room's options (by name, else by position in the picker), else the first option. */
function pickedOption(chLevels: string[], level: string | undefined, obj: string, options: string[]): string | undefined {
  if (!options.length) return undefined;
  const m = readPicks();
  const set = new Set(options);
  const latest = (ps: Pick[]) => [...ps].sort((a, b) => b.t - a.t);
  let picks = level ? (m[`${level}|${obj}`] ?? []) : [];
  // the object is picked in another level of this room (a bathtub faucet, a sink faucet)
  if (!picks.length) picks = chLevels.flatMap((l) => m[`${l}|${obj}`] ?? []);
  const byName = latest(picks).find((p) => set.has(p.o));
  if (byName) return byName.o;
  const byIndex = latest(picks)[0];
  if (byIndex) return options[Math.min(byIndex.i, options.length - 1)];
  // saved by an older version: object namecode -> option
  const old = readMap(CHOICE_KEY)[obj];
  return old && set.has(old) ? old : options[0];
}

export interface RoomArgs {
  app: Application;
  ch: Chapter;
  chapters: Chapter[];
  /** The chapter's overview prefab, or null when the game has none (the chapter picture is used). */
  overview: LevelData | null;
  /** OverviewOption namecode -> level file. */
  objects: Record<string, string>;
  /** level namecode -> level file. */
  levelOf: Record<string, string>;
  spriteMeta: Record<string, SpriteMeta>;
  spineMeta: Record<string, { scale: number }>;
  layers: { id: number }[];
  /** Level just finished: its object changes in front of the player. */
  fresh?: string | null;
  /** loading screen: share of the room's files loaded, and the room is on screen */
  onLoad?: (f: number) => void;
  ready?: () => void;
}

/** One object of the room, i.e. one level. */
interface Obj {
  level: string;
  name: string;
  /** World point the button sits on. */
  at: Point;
  icon: string;
  el?: HTMLElement;
}

/** Room drawing: the content, its background rectangle (world units) and how world maps to screen. */
interface View {
  content: Container;
  /** Background rectangle, in content units (x right, y up for scenes / down for pictures). */
  bg: { x0: number; y0: number; x1: number; y1: number };
  yUp: boolean;
}

/** Where the objects sit on the chapter picture (fractions of its size), for rooms without a prefab. */
/** [x, y, icon, radius of the clean area] as fractions of the picture width / height. */
const PICTURE_PINS: Record<string, Record<string, [number, number, string, number]>> = {
  Pool: {
    L_Bar: [0.13, 0.33, 'icon_tableset__571b4630', 0.26],
    L_BBQ: [0.58, 0.27, 'icon_stove__7c55c69f', 0.2],
    L_Statue: [0.87, 0.31, 'icon_fountain__cbfed7c3', 0.2],
    L_Pool_Pool_New: [0.66, 0.49, 'icon_pool__108cc4c0', 0.3],
  },
};

/** Icons for objects drawn by the whole background (floor, walls...) or by Spine only. */
const KEYWORD_ICON: [RegExp, string][] = [
  [/floor|carpet/i, 'icon_floor__1c321a26'],
  [/wall/i, 'icon_wall__32a629e4'],
  [/window|curtain/i, 'icon_window__aa2bd132'],
  [/pool/i, 'icon_pool__108cc4c0'],
  [/grass|yard/i, 'icon_grassyard__7958b6d6'],
  [/roof|chimney/i, 'icon_chimney__e1d3166e'],
  [/house|door/i, 'icon_home__db9fc5c8'],
  [/tree|bush/i, 'icon_bush__ceacd8f2'],
];

const spriteUrl = (key: string) => `${DATA}sprites/${key}.webp`;

export async function showRoom(a: RoomArgs): Promise<void> {
  const { app, ch } = a;
  const done = progress.done();
  const fresh = a.fresh && done.has(a.fresh) && ch.levels.some((l) => l.file === a.fresh) ? a.fresh : null;
  // what the room shows when it opens: the fresh object still dirty, it changes in a moment
  const shown = new Set(done);
  if (fresh) shown.delete(fresh);
  const complete = ch.levels.every((l) => done.has(l.file));
  const decoKey = `${ch.code}:deco`;
  const decoDone = progress.seen().has(decoKey);

  const room = a.overview ? await sceneRoom(a, shown) : await pictureRoom(a, shown);
  a.ready?.();
  let ui: HTMLDivElement | null = null;
  const { view, objs } = room;
  if (!room.node.parent) app.stage.addChildAt(room.node, 0);

  // ---- camera: the background covers the frame, a finger drags it within the background's edges --
  // The frame is the screen, narrowed to the background's width when the screen is wider than it
  // (dark bands outside), so the view never shows past the background's edges.
  const bw = view.bg.x1 - view.bg.x0;
  const bh = Math.abs(view.bg.y1 - view.bg.y0);
  const bcx = (view.bg.x0 + view.bg.x1) / 2;
  const bcy = (view.bg.y0 + view.bg.y1) / 2;
  let camX = bcx;
  let camY = bcy;
  let k = 1;
  const ROOM_ZOOM = 1.12;
  const frame = { x: 0, w: 1, h: 1 };
  const mask = new Graphics();
  app.stage.addChild(mask);
  let maskKey = '';
  const clampCam = () => {
    const hx = Math.max(0, bw / 2 - frame.w / 2 / k);
    const hy = Math.max(0, bh / 2 - frame.h / 2 / k);
    camX = Math.max(bcx - hx, Math.min(bcx + hx, camX));
    camY = Math.max(bcy - hy, Math.min(bcy + hy, camY));
  };
  const layout = () => {
    const W = app.screen.width;
    const H = app.screen.height;
    // the frame: the screen, but never wider than the background shown at full height
    frame.w = W / H < 0.8 ? W : Math.min(W, Math.ceil((bw * H) / bh));
    frame.h = H;
    frame.x = Math.round((W - frame.w) / 2);
    // cover the frame, a little closer in so it can be dragged both ways inside the background
    k = Math.max(frame.w / bw, H / bh) * ROOM_ZOOM;
    clampCam();
    const sy = view.yUp ? -k : k;
    view.content.scale.set(k, sy);
    view.content.position.set(frame.x + frame.w / 2 - camX * k, H / 2 - camY * sy);
    room.afterLayout?.(H / (2 * k), camX, camY);
    const key = `${frame.x},${frame.w},${H}`;
    if (key !== maskKey) {
      maskKey = key;
      mask.clear().rect(frame.x, 0, frame.w, H).fill(0xffffff);
      room.node.mask = frame.x > 0 ? mask : null;
      mask.visible = frame.x > 0;
      if (ui) {
        ui.style.left = `${frame.x}px`;
        ui.style.width = `${frame.w}px`;
      }
    }
  };
  /** Moves the camera just enough for a point to sit well inside the frame. */
  const focus = (p: Point) => {
    layout();
    const mx = Math.max(0, frame.w / 2 / k - 1.2 * (view.yUp ? 1 : 100));
    const my = Math.max(0, frame.h / 2 / k - 2 * (view.yUp ? 1 : 100));
    camX = Math.max(p.x - mx, Math.min(p.x + mx, camX));
    camY = Math.max(p.y - my, Math.min(p.y + my, camY));
    layout();
  };
  if (fresh) {
    const o = objs.find((x) => x.level === fresh);
    if (o) focus(o.at);
  }
  layout();

  let drag: { x: number; y: number; cx: number; cy: number } | null = null;
  const cv = app.canvas;
  cv.addEventListener('pointerdown', (e) => {
    unlockAudio();
    drag = { x: e.clientX, y: e.clientY, cx: camX, cy: camY };
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    camX = drag.cx - (e.clientX - drag.x) / k;
    camY = drag.cy + ((e.clientY - drag.y) / k) * (view.yUp ? 1 : -1);
    layout();
  });
  const up = () => (drag = null);
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  app.renderer.on('resize', layout);

  // ---- overlay: header, object buttons, footer ---------------------------------------------------
  ui = document.createElement('div');
  ui.className = 'room-ui';
  maskKey = '';
  const pins = document.createElement('div');
  pins.className = 'pins';
  const toast = document.createElement('div');
  toast.className = 'toast';
  ui.innerHTML = `<header><a class="back" href="./" aria-label="Về trang chủ">‹</a><div><b>${ROOM_VI[ch.code] ?? ch.code}</b><span class="count"></span></div></header><footer></footer>`;
  ui.append(pins, toast);
  document.body.appendChild(ui);
  const say = (t: string) => {
    toast.textContent = t;
    toast.classList.remove('on');
    void toast.offsetWidth;
    toast.classList.add('on');
  };

  const pinState = (o: Obj) => (shown.has(o.level) ? 'done' : isOpen(a.chapters, o.level) ? 'open' : 'locked');
  const nextObj = () => ch.levels.find((l) => !shown.has(l.file) && isOpen(a.chapters, l.file));
  const drawPins = () => {
    const next = nextObj();
    for (const o of objs) {
      if (!o.el) {
        const el = document.createElement('a');
        // the game's white glyph icons need a coloured disc, object pictures a light one
        const glyph = /\/icon_[^/]*$/.test(o.icon);
        el.innerHTML = `<span class="disc${glyph ? ' glyph' : ''}"><img src="${o.icon}" alt=""></span><i></i><em>${o.name}</em>`;
        el.addEventListener('click', (e) => {
          if (el.classList.contains('locked')) {
            e.preventDefault();
            el.classList.remove('shake');
            void el.offsetWidth;
            el.classList.add('shake');
            say('Hãy làm mới các món trước để mở khóa');
          }
        });
        pins.appendChild(el);
        o.el = el;
      }
      const st = pinState(o);
      o.el.className = `pin ${st}${next?.file === o.level ? ' next' : ''}`;
      if (st === 'locked') o.el.removeAttribute('href');
      else (o.el as HTMLAnchorElement).href = `?level=${encodeURIComponent(o.level)}`;
      o.el.setAttribute('aria-label', o.name);
    }
  };
  const placePins = () => {
    for (const o of objs) {
      if (!o.el) continue;
      // objects cut by the screen edge keep their button inside it
      const p = view.content.toGlobal(o.at);
      const x = Math.max(18, Math.min(frame.w - 18, p.x - frame.x));
      const y = Math.max(96, Math.min(app.screen.height - 120, p.y));
      o.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  };
  const footer = ui.querySelector('footer')!;
  const count = ui.querySelector('.count')!;
  const drawFooter = (finished: boolean) => {
    const n = ch.levels.filter((l) => shown.has(l.file)).length;
    count.textContent = `${n}/${ch.levels.length} món đã làm mới`;
    const next = nextObj();
    const idx = a.chapters.indexOf(ch);
    const nextRoom = a.chapters.slice(idx + 1).find((c) => c.levels.some((l) => isOpen(a.chapters, l.file)));
    if (finished)
      footer.innerHTML = `<div class="go done">✓ Căn phòng đã hoàn thiện</div>${nextRoom ? `<a class="go" href="?room=${encodeURIComponent(nextRoom.code)}">Phòng tiếp theo · ${ROOM_VI[nextRoom.code] ?? nextRoom.code} ›</a>` : '<a class="go" href="./">Về trang chủ</a>'}`;
    else if (next) footer.innerHTML = `<a class="go" href="?level=${encodeURIComponent(next.file)}">${n ? 'Dọn tiếp' : 'Bắt đầu dọn dẹp'} · ${next.name}</a>`;
    else footer.innerHTML = '<div class="go done">🔒 Làm xong phòng trước để mở</div>';
  };
  drawPins();
  drawFooter(complete && decoDone);
  app.ticker.add(() => {
    // the runtime may move the scene camera (ZoomCamera): the room keeps its own
    layout();
    placePins();
  });

  // the room's finishing touches, once every object is done
  const finishRoom = async () => {
    if (room.decorate) {
      pins.classList.add('hidden');
      footer.innerHTML = '';
      count.textContent = '✨ Chọn kiểu để hoàn thiện căn phòng';
      await room.decorate(true);
      pins.classList.remove('hidden');
    }
    play('Success_Magic');
    sparkle(ui, frame.w / 2, frame.h / 2, 28);
    progress.markSeen(decoKey);
    drawPins();
    drawFooter(true);
    if (!progress.seen().has(ch.code + ':ed')) {
      progress.markSeen(ch.code + ':ed');
      await wait(900);
      await showStory(ch.code, 'ed');
    }
  };

  if (complete && decoDone && room.decorate) await room.decorate(false);

  if (fresh) {
    const o = objs.find((x) => x.level === fresh);
    await wait(650);
    if (o) {
      const p = view.content.toGlobal(o.at);
      o.el?.classList.add('pop');
      await room.reveal(fresh);
      sparkle(ui, p.x - frame.x, p.y, 16);
      play('Success_Magic');
    }
    shown.add(fresh);
    drawPins();
    drawFooter(complete && decoDone);
    if (complete && !decoDone) {
      await wait(900);
      await finishRoom();
    }
  } else if (complete && !decoDone) await finishRoom();
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function sparkle(host: HTMLElement, x: number, y: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const s = document.createElement('i');
    s.className = 'spark';
    const ang = (i / n) * Math.PI * 2 + Math.random() * 0.5;
    const d = 40 + Math.random() * 70;
    s.style.left = `${x}px`;
    s.style.top = `${y}px`;
    s.style.setProperty('--dx', `${Math.cos(ang) * d}px`);
    s.style.setProperty('--dy', `${Math.sin(ang) * d}px`);
    s.style.animationDelay = `${Math.random() * 0.15}s`;
    host.appendChild(s);
    setTimeout(() => s.remove(), 1300);
  }
}

/** Tween helper on the app ticker (eased 0..1). */
function tween(app: Application, sec: number, f: (k: number) => void): Promise<void> {
  return new Promise((res) => {
    let t = 0;
    const step = (tk: { deltaMS: number }) => {
      t = Math.min(sec, t + tk.deltaMS / 1000);
      const x = t / sec;
      f(x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
      if (t >= sec) {
        app.ticker.remove(step);
        res();
      }
    };
    app.ticker.add(step);
  });
}

interface Room {
  /** What goes on the stage (the view's content or its parent). */
  node: Container;
  view: View;
  objs: Obj[];
  /** The fresh object changes from dirty to its new look. */
  reveal(level: string): Promise<void>;
  /** The overview's own decoration sequence: played (live) or re-applied from the saved picks. */
  decorate?(live: boolean): Promise<void>;
  afterLayout?(camSize: number, camX: number, camY: number): void;
}

// ---- rooms built from the original overview prefab ------------------------------------------------

interface Group {
  level?: string;
  namecode: string;
  before: GO[];
  after: GO[];
  options: { nc: string; gos: GO[] }[];
}

async function sceneRoom(a: RoomArgs, shown: Set<string>): Promise<Room> {
  const { app, ch } = a;
  const scene = new Scene(a.overview!, a.layers);
  scene.spriteMetaOf = (k) => a.spriteMeta[k];
  await scene.build(a.spriteMeta, a.spineMeta, a.onLoad);
  // the scene goes under the runtime's own overlays (option picker, tool badge)
  app.stage.addChildAt(scene.root, 0);
  const rt = new Runtime(scene, app);
  rt.onChoice = (obj, opt) => writeMap(DECO_KEY, `${ch.code}:${obj}`, opt);
  app.ticker.add((t) => rt.update(Math.min(0.05, t.deltaMS / 1000)));
  if (new URLSearchParams(location.search).get('debug')) Object.assign(window, { rt, scene, app });
  // the UI canvases of the overview (Unity buttons, pickers) are not drawn on the web
  for (const g of scene.gos) if (g.comp('Canvas')) g.setActive(false);
  scene.layout(app.screen.width, app.screen.height);

  const inChapter = new Set(ch.levels.map((l) => l.file));
  const gosOf = (v: unknown): GO[] => (Array.isArray(v) ? v : [v]).filter(isRef).map((r) => scene.get(r as Ref)).filter((g): g is GO => !!g);
  // a level whose name is in the option's name (OverviewOption_Table_MainTable -> L_Table)
  const byName = (name: string): string | undefined => {
    let best: string | undefined;
    let len = 0;
    for (const l of ch.levels) {
      const core = l.file.replace(/^L_/, '').replace(/_(New|Reskin|Inhouse|LivingRoom|Bedroom|Gara|Outdoor|Playground)$/i, '');
      if (core.length > len && name.toLowerCase().includes(core.toLowerCase())) {
        best = l.file;
        len = core.length;
      }
    }
    return best;
  };
  const groups: Group[] = [];
  const agLevel = new Map<GO, string | undefined>();
  for (const g of scene.gos) {
    const c = g.comp('OverviewOptionAfterGame');
    if (!c) continue;
    const lv = a.levelOf[c.m_LevelNamecode as string];
    const level = lv && inChapter.has(lv) ? lv : byName(String(c.m_LevelNamecode ?? ''));
    agLevel.set(g, level);
    groups.push({ level, namecode: String(c.m_LevelNamecode), before: gosOf(c.m_ListObjBefore), after: gosOf(c.m_ListObjAfter), options: [] });
  }
  for (const g of scene.gos) {
    const c = g.comp('OverviewOption');
    if (!c) continue;
    let level: string | undefined;
    for (let p = g.parent; p && !level; p = p.parent) if (agLevel.has(p)) level = agLevel.get(p);
    const nc = String(c.m_OptionObjectNamecode ?? '');
    if (!level) level = inChapter.has(a.objects[nc]) ? a.objects[nc] : byName(g.name);
    const opts = (c.m_ListOptionItem as { m_Namecode: string; m_ObjOption: unknown }[] | undefined) ?? [];
    groups.push({ level, namecode: nc, before: gosOf(c.m_ObjBefore), after: gosOf(c.m_ObjAfter), options: opts.map((o) => ({ nc: o.m_Namecode, gos: gosOf(o.m_ObjOption) })) });
  }

  // ---- the background rectangle: the room's big "bg" pictures ----
  const localRect = (g: GO) => {
    const b = g.view.getBounds();
    if (b.width * b.height <= 0) return null;
    const p = scene.world.toLocal(new Point(b.x, b.y));
    const q = scene.world.toLocal(new Point(b.x + b.width, b.y + b.height));
    return { x0: Math.min(p.x, q.x), x1: Math.max(p.x, q.x), y0: Math.min(p.y, q.y), y1: Math.max(p.y, q.y) };
  };
  const area = (r: { x0: number; x1: number; y0: number; y1: number }) => (r.x1 - r.x0) * (r.y1 - r.y0);
  // solid-colour fills (a 1x1 square stretched behind everything) are not the room's picture
  const isFill = (g: GO) => {
    const sr = g.comp('SpriteRenderer');
    const size = sr?.size as number[] | undefined;
    return /square|white|black|pixel/i.test(String(sr?.sprite ?? '')) || (!!size && size[0] * size[1] <= 1.01);
  };
  const bgs = scene.gos
    .filter((g) => g.sprite && g.activeInHierarchy && /^(bg|background)/i.test(g.name) && !isFill(g))
    .map((g) => localRect(g))
    .filter((r): r is NonNullable<typeof r> => !!r);
  const maxA = Math.max(0, ...bgs.map(area));
  const big = bgs.filter((r) => area(r) >= maxA * 0.4);
  let bg = big.length
    ? { x0: Math.min(...big.map((r) => r.x0)), x1: Math.max(...big.map((r) => r.x1)), y0: Math.min(...big.map((r) => r.y0)), y1: Math.max(...big.map((r) => r.y1)) }
    : (localRect(scene.gos[0]) ?? { x0: -5, x1: 5, y0: -8, y1: 8 });
  // a room taller than any phone is fine (it scrolls); one wider than 2 screens would be tiny
  if (area(bg) <= 0) bg = { x0: -5, x1: 5, y0: -8, y1: 8 };
  const bgArea = area(bg);

  // ---- where each object's button sits: on its dirty drawing (else its clean one) ----
  const measure = (g: GO) => {
    // measure even what is switched off now (the clean version)
    const chain: GO[] = [];
    for (let p: GO | null = g; p; p = p.parent) if (!p.selfActive) chain.push(p);
    for (const p of chain) p.view.visible = true;
    const r = localRect(g);
    for (const p of chain) p.view.visible = false;
    return r;
  };
  const spriteOf = (g: GO): string | undefined => {
    // the biggest picture of the object (its own sprite or a child's)
    let best: { key: string; a: number } | undefined;
    const walk = (x: GO) => {
      const sr = x.comp('SpriteRenderer');
      const key = typeof sr?.sprite === 'string' ? sr.sprite : undefined;
      const m = key ? a.spriteMeta[key] : undefined;
      if (key && m && sr?.enabled !== false) {
        const s = m.w * m.h * Math.abs(x.view.scale.x * x.view.scale.y);
        if (!best || s > best.a) best = { key, a: s };
      }
      for (const c of x.children) walk(c);
    };
    walk(g);
    return best?.key;
  };
  const objs: Obj[] = [];
  for (const l of ch.levels) {
    const gs = groups.filter((x) => x.level === l.file);
    let at: Point | undefined;
    let icon: string | undefined;
    const tryList = (list: GO[]) => {
      for (const g of list) {
        if (at) return;
        const r = measure(g);
        if (!r || area(r) > bgArea * 0.4) continue;
        at = new Point((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2);
        const key = spriteOf(g);
        if (key) icon = spriteUrl(key);
      }
    };
    for (const gr of gs) tryList(gr.before);
    for (const gr of gs) tryList(gr.after);
    for (const gr of gs) for (const o of gr.options) tryList(o.gos.slice(0, 1));
    // drawn by the background itself (floor, walls): the lower part of the room
    if (!at) at = new Point((bg.x0 + bg.x1) / 2, bg.y0 + (bg.y1 - bg.y0) * 0.28);
    if (!icon) icon = spriteUrl(KEYWORD_ICON.find(([re]) => re.test(l.file))?.[1] ?? 'icon_home__db9fc5c8');
    objs.push({ level: l.file, name: l.name, at, icon });
  }
  // buttons about 78 px apart on the screen the room opens on
  spreadPins(objs, 78 / Math.max(app.screen.width / (bg.x1 - bg.x0), app.screen.height / (bg.y1 - bg.y0)));

  // ---- states ----
  const want = (gr: Group) => {
    return pickedOption(
      ch.levels.map((l) => l.file),
      gr.level,
      gr.namecode,
      gr.options.map((o) => o.nc),
    );
  };
  const apply = (gr: Group, on: boolean) => {
    for (const g of gr.before) g.setActive(!on);
    for (const g of gr.after) g.setActive(on);
    const w = want(gr);
    for (const o of gr.options) for (const g of o.gos) g.setActive(on && o.nc === w);
  };
  const complete = ch.levels.every((l) => shown.has(l.file));
  for (const gr of groups) apply(gr, gr.level ? shown.has(gr.level) : complete);

  const seqRef = scene.gos[0]?.comp('OverviewLevel')?.m_Sequence as Ref | undefined;
  const seq = scene.get(seqRef) ?? scene.gos.find((g) => g.comp('SequenceManagerOverview') && !g.parent?.comp('OverviewOptionAfterGame'));

  return {
    view: { content: scene.world, bg, yUp: true },
    objs,
    node: scene.root,
    afterLayout(camSize, camX, camY) {
      // the runtime (pickers, effects) reads the camera from the scene
      scene.camSize = camSize;
      scene.camX = camX;
      scene.camY = camY;
    },
    async reveal(level) {
      const gs = groups.filter((x) => x.level === level);
      const fadeOut = gs.flatMap((x) => x.before).filter((g) => g.activeInHierarchy);
      for (const gr of gs) apply(gr, true);
      const fadeIn = gs.flatMap((x) => [...x.after, ...x.options.flatMap((o) => o.gos)]).filter((g) => g.activeInHierarchy);
      for (const g of fadeOut) g.setActive(true);
      for (const g of fadeIn) g.view.alpha = 0;
      // the new look comes in first, the old one goes after: never see-through halfway
      await tween(app, 1.1, (t) => {
        for (const g of fadeIn) g.view.alpha = Math.min(1, t / 0.6);
        for (const g of fadeOut) g.view.alpha = 1 - Math.max(0, (t - 0.4) / 0.6);
      });
      for (const g of fadeOut) {
        g.view.alpha = 1;
        g.setActive(false);
      }
      for (const g of fadeIn) g.view.alpha = 1;
      // the room may also be done now: its unmapped bits follow
      if (ch.levels.every((l) => shown.has(l.file) || l.file === level)) for (const gr of groups) if (!gr.level) apply(gr, true);
    },
    decorate: seq
      ? async (live) => {
          if (live) {
            await rt.run(seq);
            return;
          }
          // re-apply the saved picks at once, silently
          const saved = readMap(DECO_KEY);
          (rt.ui as unknown as { choose: (o: GO[]) => Promise<GO> }).choose = (opts: GO[]) => {
            const nc = (o: GO) => o.comps().find((x: CompData) => 'namecode' in x)?.namecode;
            const hit = opts.find((o) => Object.entries(saved).some(([k, v]) => k.startsWith(ch.code + ':') && v === nc(o)));
            return Promise.resolve(hit ?? opts[0]);
          };
          setMuted(true);
          const run = rt.run(seq);
          let n = 0;
          while (!rt.finished && n++ < 3000) {
            rt.update(0.1);
            if (n % 5 === 0) await wait(0);
          }
          await run.catch(() => undefined);
          setMuted(false);
          (rt as unknown as { fx: { stopAll(): void } }).fx.stopAll();
        }
      : undefined,
  };
}

/** Pushes buttons apart so none covers another (world units, `min` apart). */
function spreadPins(objs: Obj[], min: number): void {
  for (let it = 0; it < 40; it++)
    for (let i = 0; i < objs.length; i++)
      for (let j = i + 1; j < objs.length; j++) {
        const p = objs[i].at;
        const q = objs[j].at;
        let dx = q.x - p.x;
        let dy = q.y - p.y;
        let d = Math.hypot(dx, dy);
        if (d >= min) continue;
        if (d < 1e-3) {
          dx = 1;
          dy = 0;
          d = 1;
        }
        const push = (min - d) / 2;
        p.x -= (dx / d) * push;
        p.y -= (dy / d) * push;
        q.x += (dx / d) * push;
        q.y += (dy / d) * push;
      }
}

// ---- rooms without a prefab: the chapter's before / after pictures ----------------------------------

async function pictureRoom(a: RoomArgs, shown: Set<string>): Promise<Room> {
  const { app, ch } = a;
  const op = storyImage(ch.code, 'op') ?? storyImage(ch.code, 'ed')!;
  const ed = storyImage(ch.code, 'ed') ?? op;
  const [t0, t1] = await Promise.all([Assets.load<Texture>(op), Assets.load<Texture>(ed)]);
  const W = t0.width;
  const H = t0.height;
  const pins = PICTURE_PINS[ch.code] ?? {};
  const radiusOf = new Map<string, number>();
  const objs: Obj[] = ch.levels.map((l, i) => {
    const p = pins[l.file] ?? [0.2 + (0.6 * i) / Math.max(1, ch.levels.length - 1), 0.45, 'icon_home__db9fc5c8', 0.22];
    radiusOf.set(l.file, p[3] * W);
    return { level: l.file, name: l.name, at: new Point((p[0] - 0.5) * W, (p[1] - 0.5) * H), icon: spriteUrl(p[2]) };
  });
  // the clean picture shows through a soft circle around every finished object
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d')!;
  const tmp = document.createElement('canvas');
  tmp.width = W;
  tmp.height = H;
  const tctx = tmp.getContext('2d')!;
  const imgOp = t0.source.resource as CanvasImageSource;
  const imgEd = t1.source.resource as CanvasImageSource;
  const draw = (radius: (level: string) => number, all = 0) => {
    ctx.globalAlpha = 1;
    ctx.drawImage(imgOp, 0, 0, W, H);
    tctx.globalCompositeOperation = 'source-over';
    tctx.clearRect(0, 0, W, H);
    tctx.drawImage(imgEd, 0, 0, W, H);
    tctx.globalCompositeOperation = 'destination-in';
    tctx.fillStyle = '#000';
    const mask = document.createElement('canvas');
    mask.width = W;
    mask.height = H;
    const m = mask.getContext('2d')!;
    m.fillStyle = `rgba(0,0,0,${all})`;
    m.fillRect(0, 0, W, H);
    for (const o of objs) {
      const r = radius(o.level);
      if (r <= 0) continue;
      const cx = o.at.x + W / 2;
      const cy = o.at.y + H / 2;
      const g = m.createRadialGradient(cx, cy, r * 0.45, cx, cy, r);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      m.fillStyle = g;
      m.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    tctx.drawImage(mask, 0, 0);
    ctx.drawImage(tmp, 0, 0);
    tex.source.update();
  };
  const tex = Texture.from(cv);
  const sprite = new Sprite(tex);
  sprite.anchor.set(0.5);
  const content = new Container();
  content.addChild(sprite);
  const allDone = () => ch.levels.every((l) => shown.has(l.file));
  const R = (lv: string) => radiusOf.get(lv) ?? W * 0.22;
  draw((lv) => (shown.has(lv) ? R(lv) : 0), allDone() ? 1 : 0);
  return {
    node: content,
    view: { content, bg: { x0: -W / 2, x1: W / 2, y0: -H / 2, y1: H / 2 }, yUp: false },
    objs,
    async reveal(level) {
      const last = ch.levels.every((l) => shown.has(l.file) || l.file === level);
      await tween(app, 1.1, (t) => draw((lv) => (lv === level ? R(lv) * t : shown.has(lv) ? R(lv) : 0), last ? t : 0));
    },
  };
}
