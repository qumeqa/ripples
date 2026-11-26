<p>
  <img src="https://raw.githubusercontent.com/qumeqa/ripples/main/assets/logo.png" alt="Ripples.js logo" width="42">
</p>

# Ripples.js

WebGL 2 water ripple effect for `<img>`, `<picture>`, `<video>`, `<canvas>`, and CSS backgrounds. Zero dependencies, ~48 KB minified.

**[Live Demo](https://qumeqa.github.io/ripples/)** · **Browser support:** Chrome 72+, Firefox 75+, Safari 15+

- **Lazy WebGL:** creates the context on first interaction rather than on page load.
- **Zero idle overhead:** sleeps once ripples settle (0% CPU/GPU) and releases the context shortly after.
- **Accessible & CSP-safe:** respects `prefers-reduced-motion` and styles only via CSSOM (no `<style>` tags injected).
- **Graceful fallback:** leaves the DOM untouched when WebGL 2 is unavailable.

## Installation

```bash
npm i ripples-js
```

Or via CDN:

```html
<script src="https://unpkg.com/ripples-js/dist/ripples.umd.min.js" data-auto-init defer></script>
```

## Quick Start

From JavaScript:

```js
import Ripples from 'ripples-js';

const [ripples] = Ripples.init('#hero', {
  perturbance: 0.05,
  onReady: (instance) => console.log('ready', instance),
  onError: (error) => console.warn(error),
});
```

Or declaratively via HTML (requires `data-auto-init` on the `<script>` tag or calling `Ripples.autoInit()`):

```html
<img src="/images/hero.jpg" alt="Hero" data-ripples data-ripples-drop-radius="30">
<div class="banner" data-ripples data-ripples-perturbance="0.02"></div>
```

Works on `<img>`, `<picture>`, `<video>`, `<canvas>`, or any element with a CSS `background-image`. Options can be passed as `data-ripples-<kebab-case-name>` attributes with automatic JSON parsing (for example, `data-ripples-lazy="false"`). Precedence: defaults < attributes < `options` argument.

## Options

| Option | Default | Description |
|---|---|---|
| `imageUrl` | from element / `background-image` | Image or video URL (`.mp4`, `.webm`, `.ogv`, `.mov`, `.m4v`, `data:video/*`) to distort |
| `resolution` | `256` | Simulation grid size |
| `dropRadius` | `40` | Drop radius in px for a 1200 px-wide element (scales with element width) |
| `perturbance` | `0.05` | Refraction strength; `0` disables refraction |
| `interactive` | `true` | React to pointer and touch input |
| `crossOrigin` | `'anonymous'` | CORS mode for cross-origin media |
| `specular` | `false` | Specular highlight: `true` (`1.0`) or intensity |
| `damping` | `0.975` | Wave damping, `0.8`–`0.999` |
| `speed` | `1` | Simulation speed multiplier, minimum `0.1` |
| `autoPause` | `true` | Sleep the loop once ripples settle (5 s) |
| `dpr` | `'auto'` | Pixel ratio (`'auto'` is capped at `2`) |
| `lazy` | `true` | Create the WebGL context on first interaction |
| `fill` | `true` | For `<img>`, `<picture>`, `<video>`, `<canvas>`: stretch inside wrapper; `false` keeps CSS size |
| `live` | `'auto'` | Continuous texture updates for `<video>` and `<canvas>`: `'auto'`, `true`, or `false` |
| `watchTheme` | `false` | Call `refresh()` when `<html>` `class` / `data-theme` or `prefers-color-scheme` changes |
| `releaseOnIdle` | `true` | Free the WebGL context `releaseDelay` ms after settling |
| `releaseDelay` | `4000` | Delay before releasing an idle context, in ms |
| `prewarm` | `false` | Create the context during an idle callback once visible in the viewport |
| `onReady` | `null` | `(instance) => void` when media is uploaded and the effect is live |
| `onError` | `null` | `(error, instance) => void` when WebGL 2 is unavailable, a shader fails, or media fails to load |

## API

```js
new Ripples(target, options?)     // single instance (selector or Element)
Ripples.init(target?, options?)   // always returns an array; target: selector, Element, NodeList, or array
Ripples.autoInit(options?)        // initialises every [data-ripples] element without an instance
Ripples.isSupported()             // is WebGL 2 with half-float render targets available? (cached)
Ripples.maxContexts = 8           // soft cap on simultaneously live WebGL contexts
Ripples.VERSION

r.drop(x, y, radius?, strength?)  // drop at element-relative CSS pixels
r.set(name, value)                // dropRadius, perturbance, interactive, crossOrigin, specular, speed, damping, live, imageUrl
r.pause() / r.play()
r.show() / r.hide()
r.updateSize()
r.refresh()                       // re-read <img>/<picture> currentSrc, <video>/<canvas> frame, or CSS background-image
r.activate()                      // create the WebGL context immediately
r.release()                       // release the context (recreated on next interaction)
r.destroy()                       // restore the original DOM
r.supported                       // false if the effect failed to start
r.destroyed                       // true after destroy() or startup failure
```

Events (bubbling `CustomEvent` dispatched on the target element): `ripples:ready` and `ripples:error`, with `event.detail = { instance, error }`.

## Notes

- **Context budget:** browsers limit active WebGL contexts (~16). Ripples creates contexts lazily, releases idle ones, and evicts the least recently used idle instance when `Ripples.maxContexts` is exceeded (animating instances are never evicted). Use `prewarm: true` or `lazy: false` if shader compilation on first hover is noticeable.
- **Media elements:** `<img>`, `<picture>`, `<video>`, and `<canvas>` are wrapped in a `<div>` with their `margin` moved to the wrapper. For `<picture>`, the `<picture>` element itself is wrapped so `<source>` selection keeps working.
- **Video & `<canvas>`:** frames update automatically while playing (`live: 'auto'`); for a static `<canvas>`, pass `live: false` and call `refresh()` after redrawing. Passing a video URL via `imageUrl` on a `<div>` creates an internal `muted loop playsinline` `<video>`.
- **CORS:** cross-origin media requires `Access-Control-Allow-Origin` headers, otherwise WebGL rejects the upload (`onError` fires and the original media remains visible).

## Development

```bash
npm install
npm run build       # src/ripples.js -> dist/
npm test            # node:test + jsdom
npm run typecheck   # TypeScript strict check
```

## License

MIT
