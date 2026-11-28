# <img src="https://raw.githubusercontent.com/qumeqa/ripples/main/assets/logo.png" alt="Ripples.js logo" width="32" align="absmiddle"> Ripples.js

Add an interactive WebGL 2 water ripple effect to images, videos, canvases, and CSS backgrounds. Zero dependencies, ~48 KB minified.

**[Live Demo](https://qumeqa.github.io/ripples/)** · **Browser support:** Chrome 72+, Firefox 75+, Safari 15+

<p>
  <img src="https://raw.githubusercontent.com/qumeqa/ripples/main/assets/demo.webp" alt="Ripples.js interactive demo" width="720">
</p>

## Why Ripples.js?

Built from scratch as a modern, vanilla JavaScript replacement for [`jquery.ripples`](https://github.com/sirxemic/jquery.ripples):

- **Zero dependencies:** vanilla ES module & UMD bundle with TypeScript types — no jQuery required.
- **Broad media support:** works with `<img>`, `<picture>`, `<video>`, `<canvas>`, SVG, and CSS `background-image`.
- **Smart WebGL context budget:** creates the WebGL 2 context lazily on first interaction, sleeps when ripples settle (`autoPause`, 0% CPU/GPU), and releases idle contexts automatically (`releaseOnIdle`).
- **Accessible & CSP-safe:** respects `prefers-reduced-motion`, leaves the DOM untouched if WebGL 2 is unavailable, and injects no `<style>` tags.
- **Declarative or programmatic:** drop in a single `data-ripples` attribute or control everything via the JS API and presets.

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

Works on `<img>`, `<picture>`, `<video>`, `<canvas>`, or any element with a CSS `background-image`. Options can be passed as `data-ripples-<kebab-case-name>` attributes with automatic JSON parsing (for example, `data-ripples-lazy="false"` or `data-ripples-preset="calm"`). Precedence: defaults < preset < attributes < `options` argument.

### Using with React / Next.js

```tsx
import { useEffect, useRef } from 'react';
import Ripples from 'ripples-js';

export function RippleImage({ src, alt }: { src: string; alt: string }) {
  const ref = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const [instance] = Ripples.init(ref.current, { preset: 'calm' });
    return () => instance?.destroy();
  }, []);

  return <img ref={ref} src={src} alt={alt} />;
}
```

## Options

### Core Options

| Option | Default | Values | Description |
|---|---|---|---|
| preset | `null` | `null`, `default`, `subtle`, `calm`, `glossy`, `viscous` | Parameter preset applied before individual overrides |
| perturbance | `0.05` | number (typical `0`–`0.1`) | Refraction strength; `0` disables refraction |
| dropRadius | `30` | `> 0` (typical `10`–`100`) | Drop radius in px for a 1200 px longest side (scales `0.5×`–`1.3×` with element size) |
| damping | `0.975` | `0.8`–`0.999` | Wave damping |
| speed | `1` | `>= 0.1` (typical `0.2`–`2.5`) | Simulation speed multiplier |
| specular | `0.2` | `false`, `true`, or number (typical `0`–`2`) | Specular highlight: `false`/`0` disables, `true` (`1.0`), or intensity |
| interactive | `true` | `true`, `false` | React to pointer and touch input |

<details>
<summary>Advanced: performance, lifecycle, media &amp; callback options (15 more)</summary>

| Option | Default | Values | Description |
|---|---|---|---|
| imageUrl | from element / `background-image` | URL string, `null` | Image or video URL (`.mp4`, `.webm`, `.ogv`, `.mov`, `.m4v`, `data:video/*`) to distort |
| resolution | `256` | integer `> 0` (power of 2, e.g. `128`–`512`) | Simulation grid size |
| lockTouch | `false` | `true`, `false` | Prevent page scrolling while dragging on touchscreens (`touch-action: none`) |
| crossOrigin | `anonymous` | `anonymous`, `use-credentials`, `null` | CORS mode for cross-origin media (`null` disables) |
| autoPause | `true` | `true`, `false` | Sleep the loop once ripples settle (5 s) |
| dpr | `auto` | `auto` or number `> 0` | Pixel ratio (`auto` is capped at `2`) |
| lazy | `true` | `true`, `false` | Create the WebGL context on first interaction |
| fill | `true` | `true`, `false` | For `<img>`, `<picture>`, `<video>`, `<canvas>`: stretch inside wrapper; `false` keeps CSS size |
| live | `auto` | `auto`, `true`, `false` | Continuous texture updates for `<video>` and `<canvas>` |
| watchTheme | `false` | `true`, `false` | Call `refresh()` when `<html>` `class` / `data-theme` or `prefers-color-scheme` changes |
| releaseOnIdle | `true` | `true`, `false` | Free the WebGL context `releaseDelay` ms after settling |
| releaseDelay | `4000` | `>= 0` (ms) | Delay before releasing an idle context |
| prewarm | `false` | `true`, `false` | Create the context during an idle callback once visible in the viewport |
| onReady | `null` | `(instance) => void`, `null` | Called when media is uploaded and the effect is live |
| onError | `null` | `(error, instance) => void`, `null` | Called when WebGL 2 is unavailable, a shader fails, or media fails to load |

</details>

## Presets

Presets configure `perturbance`, `dropRadius`, `damping`, `speed`, and `specular` together without touching lifecycle or performance options:

| Preset | perturbance | dropRadius | damping | speed | specular |
|---|---|---|---|---|---|
| default | `0.05` | `30` | `0.975` | `1` | `0.2` |
| subtle | `0.02` | `35` | `0.96` | `0.85` | `false` |
| calm | `0.035` | `55` | `0.985` | `0.75` | `0.25` |
| glossy | `0.05` | `35` | `0.98` | `1.15` | `0.75` |
| viscous | `0.075` | `65` | `0.945` | `0.65` | `0.4` |

```js
const [ripples] = Ripples.init('#hero', { preset: 'calm', specular: 0.4 });
ripples.set('preset', 'glossy');
```

## API

<details>
<summary>Methods, static properties &amp; events</summary>

```js
new Ripples(target, options?)     // single instance (selector or Element)
Ripples.init(target?, options?)   // always returns an array; target: selector, Element, NodeList, or array
Ripples.autoInit(options?)        // initialises every [data-ripples] element without an instance
Ripples.isSupported()             // is WebGL 2 with half-float render targets available? (cached)
Ripples.maxContexts = 8           // soft cap on simultaneously live WebGL contexts
Ripples.PRESETS                   // built-in presets: default, subtle, calm, glossy, viscous
Ripples.VERSION

r.drop(x, y, radius?, strength?)  // drop at element-relative CSS pixels
r.set(name, value)                // dropRadius, perturbance, interactive, lockTouch, crossOrigin, specular, speed, damping, live, imageUrl, preset
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

</details>

## Notes

<details>
<summary>Context budget, media wrappers, video/canvas &amp; CORS details</summary>

- **Context budget:** browsers limit active WebGL contexts (~16). Ripples creates contexts lazily, releases idle ones, and evicts the least recently used idle instance when `Ripples.maxContexts` is exceeded (animating instances are never evicted). Use `prewarm: true` or `lazy: false` if shader compilation on first hover is noticeable.
- **Media elements:** `<img>`, `<picture>`, `<video>`, and `<canvas>` are wrapped in a `<div>` with their `margin` moved to the wrapper. For `<picture>`, the `<picture>` element itself is wrapped so `<source>` selection keeps working.
- **Video & `<canvas>`:** frames update automatically while playing (`live: 'auto'`); for a static `<canvas>`, pass `live: false` and call `refresh()` after redrawing. Passing a video URL via `imageUrl` on a `<div>` creates an internal `muted loop playsinline` `<video>`.
- **CORS:** cross-origin media requires `Access-Control-Allow-Origin` headers, otherwise WebGL rejects the upload (`onError` fires and the original media remains visible).

</details>

## Development

```bash
npm install
npm run build       # src/ripples.js -> dist/
npm test            # node:test + jsdom
npm run typecheck   # TypeScript strict check
```

## License

MIT
