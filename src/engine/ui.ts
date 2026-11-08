// Option picker for ChooseOption / ChooseOptionTool / InteractiveMultiTool: a bottom
// card with the option icons taken from the original uGUI Images.
import { Assets, Container, Graphics, Sprite, Text, type Application, type Texture } from 'pixi.js';
import type { GO, Scene } from './scene';

export class ChooserUI {
  readonly view = new Container();
  busy = false;

  constructor(
    private readonly app: Application,
    private readonly scene: Scene,
  ) {
    app.stage.addChild(this.view);
  }

  /** Icon for an option: the first uGUI Image sprite under it (its m_ImgContainer first). */
  iconOf(o: GO): Texture | null {
    const item = o.comps().find((c) => 'm_ImgContainer' in c);
    const roots: GO[] = [];
    const ic = item ? this.scene.get(item.m_ImgContainer as never) : undefined;
    if (ic) roots.push(ic);
    roots.push(o);
    for (const r of roots) {
      const stack = [r];
      while (stack.length) {
        const g = stack.shift()!;
        const img = g.comp('Image');
        const sp = (img?.m_Sprite as { sprite?: string } | undefined)?.sprite;
        if (sp && !/frame|border|bg|button|btn|select|ads|icon_ad/i.test(sp)) {
          if (Assets.cache.has('s:' + sp)) return Assets.get<Texture>('s:' + sp);
        }
        stack.push(...g.children);
      }
    }
    return null;
  }

  private first: (() => void) | null = null;
  private bar: Container | null = null;

  /** Is a screen point on the tool bar (taps there are not game taps)? */
  onBar(x: number, y: number): boolean {
    if (!this.bar) return false;
    const b = this.bar.getBounds();
    return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
  }

  /** Tool swap bar (InteractiveMultiTool allowSwapToolAfterSelect): small icons along the
   * top, the tool in use highlighted. Returns a function that removes it. */
  toolBar(options: GO[], current: number, onPick: (i: number) => void): () => void {
    this.bar?.destroy({ children: true });
    const bar = new Container();
    const size = 44;
    const draw = (cur: number) => {
      bar.removeChildren();
      const w = this.app.screen.width;
      // a row under the progress bar, out of the way of the object being cleaned
      const y = safeTop() + 56 + size / 2;
      options.forEach((o, i) => {
        const b = new Container();
        b.position.set(w - 16 - size / 2 - (options.length - 1 - i) * (size + 8), y);
        b.addChild(new Graphics().roundRect(-size / 2, -size / 2, size, size, 11).fill({ color: i === cur ? 0xfff3c4 : 0xffffff, alpha: 0.95 }).stroke({ color: i === cur ? 0xf2a93b : 0xd9c8b0, width: i === cur ? 4 : 2 }));
        const t = this.iconOf(o);
        if (t) {
          const s = new Sprite(t);
          s.anchor.set(0.5);
          s.scale.set((size - 12) / Math.max(t.width, t.height));
          b.addChild(s);
        }
        b.eventMode = 'static';
        b.cursor = 'pointer';
        b.on('pointertap', () => {
          if (i === cur) return;
          draw(i);
          onPick(i);
        });
        bar.addChild(b);
      });
    };
    draw(current);
    this.view.addChild(bar);
    this.bar = bar;
    return () => {
      if (this.bar === bar) this.bar = null;
      bar.destroy({ children: true });
    };
  }

  /** Debug auto-play: pick the first option. */
  pickFirst(): void {
    (this.pickers[Math.min(this.debugPick, this.pickers.length - 1)] ?? this.first)?.();
  }

  /** Debug / QA: which option pickFirst() takes (to test every tool choice). */
  debugPick = 0;
  private pickers: (() => void)[] = [];

  private queue: Promise<unknown> = Promise.resolve();

  /** One picker at a time: a second request waits for the first to be answered. */
  choose(options: GO[], titleText = 'Chọn một kiểu'): Promise<GO> {
    const p = this.queue.then(() => this.show(options, titleText));
    this.queue = p.catch(() => undefined);
    return p;
  }

  private show(options: GO[], titleText: string): Promise<GO> {
    const opts = options.filter((o) => o);
    if (!opts.length) return Promise.reject(new Error('no options'));
    this.busy = true;
    return new Promise((resolve) => {
      const w = this.app.screen.width;
      const h = this.app.screen.height;
      const panelH = Math.min(148, h * 0.21);
      const sb = safeBottom();
      const panel = new Container();
      const bg = new Graphics().roundRect(12, h - panelH - 16 - sb, w - 24, panelH, 22).fill({ color: 0xffffff, alpha: 0.95 });
      panel.addChild(bg);
      const title = new Text({ text: titleText, style: { fontFamily: 'system-ui, sans-serif', fontSize: 14, fontWeight: '700', fill: 0x3a2d26 } });
      title.anchor.set(0.5, 0);
      title.position.set(w / 2, h - panelH - 4 - sb);
      panel.addChild(title);
      const n = opts.length;
      const cell = Math.min(86, (w - 48) / n);
      const y = h - panelH / 2 - 4 - sb;
      opts.forEach((o, i) => {
        const x = w / 2 + (i - (n - 1) / 2) * cell;
        const btn = new Container();
        btn.position.set(x, y);
        const box = new Graphics().roundRect(-cell / 2 + 5, -cell / 2 + 5, cell - 10, cell - 10, 13).fill(0xf3ede4).stroke({ color: 0xd9c8b0, width: 2 });
        btn.addChild(box);
        const t = this.iconOf(o);
        if (t) {
          const s = new Sprite(t);
          s.anchor.set(0.5);
          const k = (cell - 24) / Math.max(t.width, t.height);
          s.scale.set(k);
          btn.addChild(s);
        } else {
          const lbl = new Text({ text: String(i + 1), style: { fontSize: 28, fontWeight: '800', fill: 0x6b5442 } });
          lbl.anchor.set(0.5);
          btn.addChild(lbl);
        }
        btn.eventMode = 'static';
        btn.cursor = 'pointer';
        const pick = () => {
          this.view.removeChildren();
          this.busy = false;
          this.first = null;
          this.pickers = [];
          resolve(o);
        };
        if (i === 0) {
          this.first = pick;
          this.pickers = [];
        }
        this.pickers.push(pick);
        btn.on('pointertap', pick);
        panel.addChild(btn);
      });
      this.view.addChild(panel);
    });
  }
}

/** WaitForEndMinigame / PairsManager: drag a wire from each left dot to the dot of the same colour. */
export function matchPairs(app: Application, colors: number[], onLink: () => void): Promise<void> {
  return new Promise((resolve) => {
    const w = app.screen.width;
    const h = app.screen.height;
    const root = new Container();
    root.eventMode = 'static';
    const card = new Graphics().roundRect(16, h * 0.3, w - 32, h * 0.4, 24).fill({ color: 0x24303c, alpha: 0.95 });
    const title = new Text({ text: 'Nối dây cùng màu', style: { fontFamily: 'system-ui, sans-serif', fontSize: 18, fontWeight: '700', fill: 0xffffff } });
    title.anchor.set(0.5, 0);
    title.position.set(w / 2, h * 0.3 + 14);
    const lines = new Graphics();
    const live = new Graphics();
    root.addChild(card, title, lines, live);
    const n = colors.length;
    // shuffled, but never left in the same order as the left column
    const right = colors.map((_, i) => i).sort(() => Math.random() - 0.5);
    if (n > 1 && right.every((v, i) => v === i)) right.push(right.shift()!);
    const y = (i: number) => h * 0.3 + 70 + (i * (h * 0.4 - 100)) / Math.max(1, n - 1);
    const L = colors.map((c, i) => ({ x: 70, y: y(i), c, done: false }));
    const R = right.map((ci, i) => ({ x: w - 70, y: y(i), c: colors[ci], done: false }));
    const dots = new Graphics();
    root.addChild(dots);
    const redraw = () => {
      dots.clear();
      for (const d of [...L, ...R]) dots.circle(d.x, d.y, 18).fill(d.c).stroke({ color: 0xffffff, width: d.done ? 5 : 3 });
    };
    redraw();
    let from: (typeof L)[number] | null = null;
    root.on('pointerdown', (e) => {
      from = L.find((d) => !d.done && Math.hypot(d.x - e.global.x, d.y - e.global.y) < 34) ?? null;
    });
    root.on('pointermove', (e) => {
      live.clear();
      if (from) live.moveTo(from.x, from.y).lineTo(e.global.x, e.global.y).stroke({ color: from.c, width: 8, cap: 'round' });
    });
    const end = (e: { global: { x: number; y: number } }) => {
      live.clear();
      if (!from) return;
      const to = R.find((d) => !d.done && Math.hypot(d.x - e.global.x, d.y - e.global.y) < 40);
      if (to && to.c === from.c) {
        from.done = to.done = true;
        lines.moveTo(from.x, from.y).lineTo(to.x, to.y).stroke({ color: from.c, width: 8, cap: 'round' });
        onLink();
        redraw();
        if (L.every((d) => d.done)) {
          setTimeout(() => {
            root.destroy({ children: true });
            resolve();
          }, 500);
        }
      }
      from = null;
    };
    root.on('pointerup', end);
    root.on('pointerupoutside', end);
    root.hitArea = app.screen;
    (root as Container & { autoSolve?: () => void }).autoSolve = () => {
      for (const d of L) {
        if (d.done) continue;
        from = d;
        const r = R.find((x) => x.c === d.c && !x.done);
        if (r) end({ global: r });
      }
    };
    app.stage.addChild(root);
    matchRoot = root;
  });
}

let matchRoot: Container | null = null;
/** Debug auto-play: finish an open matching mini-game. */
export function autoSolveMatch(): void {
  (matchRoot as (Container & { autoSolve?: () => void }) | null)?.autoSolve?.();
}

function safeBottom(): number {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;padding-bottom:env(safe-area-inset-bottom,0px)';
  document.body.appendChild(probe);
  const v = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
  probe.remove();
  return v;
}

/** Top safe-area inset (notch) in CSS px. */
export function safeTop(): number {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top,0px)';
  document.body.appendChild(probe);
  const v = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return v;
}

/** The tool in use: the original's tool thumbnail in a small tile under the step bar
 * (the step's progress is shown by the HUD's bar). */
export class ToolBadge {
  readonly view = new Container();
  private readonly icon = new Sprite();
  shown = false;

  constructor(private readonly app: Application) {
    this.view.addChild(new Graphics().roundRect(0, 0, 40, 40, 12).fill({ color: 0xffffff, alpha: 0.9 }).stroke({ color: 0xd9c8b0, width: 1.5 }));
    this.icon.anchor.set(0.5);
    this.icon.position.set(20, 20);
    this.view.addChild(this.icon);
    this.view.visible = false;
    app.stage.addChild(this.view);
  }

  show(tex: Texture | null): void {
    if (!tex) return;
    this.icon.texture = tex;
    this.icon.scale.set(30 / Math.max(tex.width, tex.height));
    this.view.position.set(12, safeTop() + 52);
    this.view.visible = this.shown = true;
  }

  /** Kept for callers: the progress lives on the HUD's step bar. */
  set(_p: number): void {}

  hide(): void {
    this.view.visible = this.shown = false;
  }
}
