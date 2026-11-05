// Bridge to the GameKit preview panel (and a plain console fallback).
//
// - emit(name, data): moments that matter (level start, win, lose, a purchase,
//   a tutorial step). The preview's "Events" drawer shows them live; in a
//   published build they are harmless console.debug lines that mark where an
//   analytics SDK would hook in later.
// - registerLevels({ count, current, goTo }): lists the game's levels in the
//   preview's "Levels" panel and level dropdown. Clicking a level calls goTo();
//   "Capture thumbnails" visits every level and grabs the canvas.
// - levelChanged(level): call whenever the game moves to another level on its
//   own (next level after a win, retry), so the preview highlights it.
//
// Nothing here runs unless the page is inside the GameKit preview.

export type GameEventData = Record<string, string | number | boolean | null | undefined>;

export interface LevelsHost {
  /** Total number of levels (shown as 1…count). */
  count: number;
  /** The level being played or shown, 1-based. */
  current: () => number;
  /** Jump straight to a level, 1-based (skip menus, start playing). */
  goTo: (level: number) => void;
  /** Optional short names, index 0 = level 1. */
  names?: string[];
  /** Canvas to snapshot for thumbnails (default: the first <canvas> on the page). */
  canvas?: HTMLCanvasElement;
  /** Milliseconds to wait after goTo() before taking a thumbnail (default 250). */
  settleMs?: number;
}

const embedded = (() => {
  try {
    return window.parent !== window;
  } catch {
    return true;
  }
})();

function post(message: Record<string, unknown>): void {
  if (!embedded) return;
  try {
    window.parent.postMessage(message, '*');
  } catch {
    // Parent refused the message — nothing to do.
  }
}

export function emit(name: string, data: GameEventData = {}): void {
  post({ type: 'gamekit:event', name, data, ts: Date.now() });
  console.debug('[gamekit]', name, data);
}

let levelsHost: LevelsHost | undefined;
let capturing = false;

function announceLevels(): void {
  if (!levelsHost) return;
  post({ type: 'gamekit:levels', count: levelsHost.count, current: levelsHost.current(), names: levelsHost.names });
}

export function registerLevels(host: LevelsHost): void {
  levelsHost = host;
  announceLevels();
}

export function levelChanged(level: number): void {
  if (capturing) return; // thumbnails jump through levels; the preview restores the real one afterwards
  post({ type: 'gamekit:level', current: level });
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function captureThumbnails(width: number): Promise<void> {
  const host = levelsHost;
  if (!host || capturing) return;
  const source = host.canvas ?? document.querySelector('canvas');
  if (!source) {
    post({ type: 'gamekit:thumbsDone' });
    return;
  }
  capturing = true;
  const back = host.current();
  const thumb = document.createElement('canvas');
  const ctx = thumb.getContext('2d')!;
  try {
    for (let level = 1; level <= Math.min(host.count, 200); level++) {
      host.goTo(level);
      await nextFrame();
      await nextFrame();
      await wait(host.settleMs ?? 250);
      const ratio = source.height / Math.max(1, source.width);
      thumb.width = width;
      thumb.height = Math.round(width * ratio);
      ctx.drawImage(source, 0, 0, thumb.width, thumb.height);
      let dataUrl = '';
      try {
        dataUrl = thumb.toDataURL('image/jpeg', 0.72);
      } catch {
        break; // tainted canvas (cross-origin image): no thumbnails possible
      }
      post({ type: 'gamekit:thumb', level, dataUrl });
    }
  } finally {
    host.goTo(back);
    capturing = false;
    post({ type: 'gamekit:thumbsDone' });
    announceLevels();
  }
}

if (embedded) {
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window.parent) return;
    const m = e.data as { type?: string; level?: number; width?: number } | null;
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'gamekit:hello') announceLevels();
    if (m.type === 'gamekit:goto' && levelsHost && typeof m.level === 'number') {
      const level = Math.max(1, Math.min(levelsHost.count, Math.floor(m.level)));
      levelsHost.goTo(level);
      levelChanged(level);
    }
    if (m.type === 'gamekit:captureThumbs') void captureThumbnails(Math.max(60, Math.min(400, Number(m.width) || 180)));
  });
}

/** `?debug=1` in the URL turns on on-screen diagnostics. */
export const DEBUG = new URLSearchParams(location.search).has('debug');
