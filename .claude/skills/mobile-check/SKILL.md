---
name: mobile-check
description: Review this HTML5 game for mobile readiness (touch, safe area, resize, performance, single-file build) and fix what is cheap to fix. Use before sharing a build or when the preview looks wrong on a phone preset.
---

# mobile-check

Audit the game the way a phone will run it, then fix the small things and list the rest.

## Steps

1. Read `src/main.ts`, `src/game.ts`, `src/input.ts` and `index.html`.
2. Check each item below. For every item write **OK** or **FIX** with the file and line.
3. Apply fixes that are local and safe (a missing `preventDefault`, a hard-coded width, a per-frame allocation).
4. Run `npm run typecheck`, then `npm run build`. Confirm that `dist/` contains exactly one `index.html` and no other asset files.
5. Report: a short table of the checks, what you changed, and what you recommend but did not change.

## Checklist

- **Viewport**: `index.html` has `viewport-fit=cover`, `user-scalable=no`; no white flash before the first frame.
- **Resize**: the canvas follows `window.innerWidth/innerHeight` and `devicePixelRatio` (capped at 3); orientation change handled.
- **Safe area**: HUD elements stay below the top inset (`--sat`) and above the bottom edge.
- **Touch**: `touch-action: none` on the canvas; `pointerdown` used (not `click`); no hover-only interaction; hit areas ≥ 44 px.
- **Loop**: `dt` is clamped; nothing runs while `document.hidden`; no `new` objects or string building inside `draw()` per bubble/entity.
- **Audio** (if any): unlocked on the first pointer event; nothing autoplays on load.
- **Text**: system font stack only unless a font file is inlined; no text smaller than 14 px.
- **Events**: `emit('levelStart')`, `emit('win')`, `emit('lose')` fire exactly once per level.
- **Build**: `npm run build` succeeds; `dist/index.html` is self-contained (no `<script src=` or `<link href=` to external files).

## Rules

- Do not change gameplay rules or difficulty while fixing.
- Do not add dependencies.
