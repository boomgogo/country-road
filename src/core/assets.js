/* ------------------------------------------------------------------ *
 * Where the static files are.
 *
 * Three things ship in `public/` rather than through the bundler -- the
 * star catalogue, the car GLB and the favicon -- and two of them are
 * fetched by hand at runtime.  Both used to be fetched by a bare
 * relative path (`'stars.bin'`), which the browser resolves against the
 * *document* URL.  At `https://host/` that is right by accident: the
 * document is at the root, so the catalogue is looked for at the root.
 * Move the app one directory down and every one of those fetches goes
 * looking in the wrong place -- and `celestial.js` answers a failed
 * catalogue with a starless sky rather than an error, so the symptom is
 * a night that is simply empty and says nothing about why.
 *
 * `import.meta.env.BASE_URL` is the fix, but only if `vite.config.js`
 * keeps an *absolute* base.  Under a relative base (`'./'`) Vite compiles
 * `BASE_URL` to the literal `'./'`, and `'./' + 'stars.bin'` resolves
 * against the document exactly like the bare path did -- the same bug
 * wearing a helmet.  See the note in `vite.config.js`.
 * ------------------------------------------------------------------ */

/**
 * Resolve a path under `public/` to a URL valid from any page in the app.
 *
 * @param {string} path Path relative to `public/`, no leading slash --
 *   e.g. `'stars.bin'`, `'models/car/sportscar.glb'`.
 * @returns {string} The URL to fetch.
 */
export function assetUrl(path) {
  return import.meta.env.BASE_URL + path.replace(/^\/+/, '');
}
