import { defineConfig } from 'vite';

export default defineConfig({
  /* Absolute, and it has to stay absolute.  `core/assets.js` builds the
   * runtime fetches for `public/` out of `import.meta.env.BASE_URL`, and
   * Vite compiles that to whatever this string is -- so a relative `'./'`
   * here silently turns those back into document-relative paths that only
   * work while the app sits at a domain root.  To deploy under a
   * subdirectory, build with an absolute base for it instead:
   *     vite build --base=/road/
   */
  base: '/',
  server: { port: 5178, host: '127.0.0.1', open: false },
  preview: { port: 5179, host: '127.0.0.1' },
  build: { outDir: 'dist', target: 'es2022', chunkSizeWarningLimit: 1400 },
});
