# Home Clean Makeover — project notes for Codex

Web remake of the Unity game "Home Clean: Makeover ASMR" (the user's own game), made with GameKit.
Vite + TypeScript + PixiJS v8 + Spine (spine-pixi-v8). The levels are the original Unity prefabs
exported to JSON and replayed by a small runtime that implements the game's own script components
(TweenStep / TweenSequence actions and interactive tasks).

## Commands
- `npm run typecheck` — run after every change; the build fails on type errors.
- `npm run build` — `dist/` = `index.html` + `assets/` + `data/` (NOT a single file: the data is ~175 MB).
- `npm run dev` — dev server on http://127.0.0.1:5210 (the GameKit preview runs it itself; do not start a second one).
- `npm run asset -- "<prompt>" src/assets/<name>.png` — Gemini asset generation (see the global rules).

## Pages
- `./` home (chapters, story, progress) · `?room=Kitchen` a chapter's room · `?level=L_Sink` one object (level).
- `?debug=1` exposes `rt`, `scene`, `app` on window. `?auto=1` plays the level by itself and leaves a QA
  report in `window.__result` (finished, stuck steps, quiet steps, missing animations, tools left on screen…).
- The 🛠 button opens the cheat popup (skip step, jump to step, autoplay, unlock all, reset progress).

## Where things are
- `src/main.ts` — boot, routes, HUD, auto-test; registers the 57 levels with GameKit (`registerLevels`) and
  emits `levelStart`, `step`, `win`.
- `src/home.ts`, `src/room.ts`, `src/cheat.ts` — home page and story, room overview, cheat popup.
- `src/engine/scene.ts` — builds a level: GameObjects, sprites (simple / 9-slice / tiled), Spine, colliders, sorting.
- `src/engine/runtime.ts` — the script player: `action()` = one-shot tweens, `makeTask()` = interactive tasks
  (scratch, drag, slots, hold, tap/break, choose option, bug kill, multi-tool…), input, hints, tool badge, QA.
- `src/engine/scratch.ts` — ScratchCardManager (erase / fill masks, progress grid, foam fill for soap layers).
- `src/engine/particles.ts` — Unity ParticleSystem emulation with the original textures.
- `src/engine/behaviors.ts` — bone followers, insects, drop-in objects, highlight flashes.
- `src/engine/fx.ts`, `ui.ts`, `audio.ts` — fallback effects + hand hint, option picker / tool bar / tool badge, sounds.
- `public/data/` — exported game data: `levels/*.json`, `sprites/`, `spine/`, `fx/`, `audio/`, `story/`.
- `tools/` — data tools: `tree.py` / `outline.py` (print a level's GameObject tree), `spine_export.py` +
  `apply_spine_variants.py` (re-export Spine skeletons from the XAPK), `gen-asset.mjs` (Gemini).

## Rules
- Behaviour comes from the original data: before changing how a tool or step works, read the step with
  `python3 tools/tree.py public/data/levels/L_<Level>.json <node name|index> [depth]` and follow its components.
- Mobile first: portrait, one finger, safe areas (`env(safe-area-inset-*)`).
- After a change: `npm run typecheck`, then check the level in the preview; for wide changes run the
  `?auto=1` report on all levels (57 should finish).
- Do not change the `package.json` scripts unless asked. No new dependencies without saying why.
