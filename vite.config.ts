import { defineConfig } from 'vite';

// Multi-file build: the game data (public/data, ~175 MB of levels, sprites, Spine, audio)
// is far too big to inline, so dist/ is index.html + assets/ + data/. Relative base so it
// works from any folder or sub-path (static hosting, file server, web view).
export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5210 },
  build: { target: 'es2020', chunkSizeWarningLimit: 2000 },
});
