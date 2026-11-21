import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

/**
 * Which build this is: `v.` and the first four hex digits of the commit.
 *
 * Worked out once, here, rather than at runtime: the page has no way to
 * ask git anything, and a version fetched from somewhere is a request on
 * the load path for four characters.  Cloudflare's git-connected builds
 * set `WORKERS_CI_COMMIT_SHA`; a local `npm run deploy` asks git; a
 * checkout with no git at all says `dev`.
 *
 * A tree with uncommitted changes still says HEAD's hash, exactly as the
 * template in `ai/prompt_5.md` asks -- and the build says so out loud, so
 * the person deploying it knows the label is a commit and not the files.
 */
function commit() {
  const env = process.env.WORKERS_CI_COMMIT_SHA;
  if (env) return env.slice(0, 4);
  try {
    const sha = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    const dirty = execSync('git status --porcelain --untracked-files=no',
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (dirty) console.warn(`[version] uncommitted changes: the label says v.${sha.slice(0, 4)}, which is HEAD`);
    return sha.slice(0, 4);
  } catch {
    return 'dev';
  }
}

const COMMIT = commit();

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
  /* For the script: `?debug=1`'s first line, `__game.version`, and one
   * line in the console, so a bug report can name its build. */
  define: { __COMMIT__: JSON.stringify(COMMIT) },
  plugins: [{
    /* And for the markup, which is where the label actually lives.  The
     * load screen is static HTML for a reason `index.html` gives -- no
     * module code runs until the physics wasm has arrived -- and a version
     * written by JavaScript would appear after the wait.  This way it is
     * in the first paint and costs nothing. */
    name: 'commit-label',
    transformIndexHtml: (html) => html.replaceAll('%COMMIT%', COMMIT),
  }],
});
