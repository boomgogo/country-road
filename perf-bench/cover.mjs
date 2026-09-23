/* ------------------------------------------------------------------ *
 * Does the sky still mean what `w.cloud` says it means?
 *
 * `cloudfield.js` is built around one invariant: coverage is a *quantile*,
 * so `w.cloud = 0.45` means 45 % of the sky and not a number that happens
 * to look right at noon.  The march honours it by construction -- it
 * integrates the field itself.  The drawn layer in `world/cloudgeo.js`
 * does not: it decides a cloud per cell and then draws a cluster of fixed
 * size, so the sky fraction is a *consequence* of the cell size and the
 * cloud radius agreeing, and nothing but a measurement can say they do.
 *
 * This is that measurement.  Both layers, the same weathers, the same
 * definition of cover -- mean alpha over the upper half of the frame,
 * which is `Clouds.coverFraction` and now `CloudGeo.coverFraction` as
 * well.
 *
 *     npx vite --port 5178
 *     HEADLESS=1 node ai/perf-bench/cover.mjs
 *
 * What to read: the *ratio* column, not the difference.  Neither layer
 * will match `w.cloud` exactly -- a ray at a grazing angle crosses many
 * cells, so the cover seen from inside a deck is always above the cover
 * seen from above it -- but the two layers should be in the same place
 * and the ratio should be flat across the weathers.  A ratio that slopes
 * is a cell size and a radius that disagree.
 * ------------------------------------------------------------------ */
import { launch } from './cdp.mjs';

const PORT = process.env.PORT || 5178;
const SEED = process.env.SEED || 'country';
const WEATHERS = (process.env.WEATHERS || 'sunny,fair,cloudy,rain').split(',');

const c = await launch({ w: 1280, h: 720 });
await c.send('Page.enable');
await c.send('Emulation.setDeviceMetricsOverride',
             { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

const rows = [];
for (const mode of ['geo', 'march']) {
  for (const weather of WEATHERS) {
    await c.send('Page.navigate', {
      url: `http://127.0.0.1:${PORT}/?rec=1&fresh&sound=0&seed=${SEED}`
         + `&t=10:00&season=summer&day=1&dynres=0&quality=high`
         + `&weather=${weather}&clouds=${mode}`,
    });
    for (let i = 0; i < 240; i++) {
      if (await c.evaluate('!!(window.__game && window.__game.loaded)').catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await c.evaluate('window.__game.loaded');
    /* Down the road a little, and settled: the march needs its history to
     * converge and the drawn layer needs a camera that has stopped
     * moving, or its rebuild threshold has not fired yet. */
    for (let s = 20; s <= 2020; s += 500) {
      await c.evaluate(`__game.jumpTo(${s}, 50)`);
      await c.evaluate('__game.present()');
    }
    for (let i = 0; i < 20; i++) await c.evaluate('__game.present()');
    const r = await c.evaluate(`(() => {
      const g = __game;
      return JSON.stringify({
        want: g.weather.p.cloud,
        got: g.clouds.coverFraction(g.renderer),
        n: g.clouds.count === undefined ? null : g.clouds.count,
      });
    })()`);
    rows.push({ mode, weather, ...JSON.parse(r) });
    const x = rows[rows.length - 1];
    console.log(`${mode.padEnd(6)} ${weather.padEnd(7)} w.cloud=${x.want.toFixed(3)}`
      + `  cover=${x.got.toFixed(3)}  ratio=${(x.want > 0.01 ? x.got / x.want : NaN).toFixed(2)}`
      + `${x.n === null ? '' : `  clusters=${x.n}`}`);
  }
}

c.close();
