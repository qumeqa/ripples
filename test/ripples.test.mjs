import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createEnv, fakeGL, wait, ptr, UMD_MIN } from './helpers.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const quiet = (fn) => async (t) => {
  const w = console.warn; console.warn = () => {};
  try { await fn(t); } finally { console.warn = w; }
};

/* ---------- packaging ---------- */

test('ESM build: default + named export, no side effects without a DOM', async () => {
  const m = await import('../dist/ripples.mjs');
  assert.equal(typeof m.default, 'function');
  assert.equal(m.default, m.Ripples);
  assert.equal(m.default.VERSION, pkg.version);
  assert.deepEqual(m.default.init(), []);
  assert.deepEqual(m.default.autoInit(), []);
  assert.equal(m.default.isSupported(), false);
});

test('UMD build: require() returns the class', () => {
  const R = createRequire(import.meta.url)('../dist/ripples.umd.js');
  assert.equal(typeof R, 'function');
  assert.equal(R.VERSION, pkg.version);
});

test('minified UMD behaves like the readable one', () => {
  const { Ripples, doc } = createEnv({ source: UMD_MIN, gl: fakeGL(), html: '<body><div id="a"></div></body>' });
  const [r] = Ripples.init('#a');
  assert.ok(r instanceof Ripples && r.supported);
  assert.ok(doc.querySelector('#a canvas'));
});

/* ---------- failure handling ---------- */

test('no WebGL: DOM restored, onError + ripples:error event', quiet(async () => {
  const { w, doc, Ripples } = createEnv({ gl: null, html: '<body><div id="a" style="background-image:url(x.jpg)"></div><img id="i" src="p.jpg" style="width:300px;margin:7px"></body>' });
  const div = doc.getElementById('a');
  let err = null, evt = null;
  div.addEventListener('ripples:error', (e) => (evt = e.detail));
  const [r] = Ripples.init('#a', { onError: (e) => (err = e) });
  assert.equal(r.supported, false);
  assert.ok(r.destroyed);
  assert.equal(typeof err.message, 'string'); // jsdom has its own Error realm, so no instanceof
  await wait(5);
  assert.equal(evt.error, err);
  assert.ok(!div.classList.contains('webgl-ripples'));
  assert.ok(div.style.backgroundImage.includes('x.jpg'), 'inline background kept');
  assert.equal(div.style.position, '');
  assert.equal(div.style.isolation, '');
  assert.equal(div.querySelector('canvas'), null);

  const img = doc.getElementById('i');
  Ripples.init(img);
  assert.equal(img.parentNode, doc.body);
  assert.equal(img.style.width, '300px');
  assert.equal(img.style.margin, '7px');
}));

test('shader compile error: rolled back, onError carries the shader log', quiet(() => {
  const { doc, Ripples } = createEnv({ gl: fakeGL({ badShader: true }), html: '<body><div id="a"></div></body>' });
  let err = null;
  const r = new Ripples(doc.getElementById('a'), { lazy: false, onError: (e) => (err = e) });
  assert.ok(r.destroyed && r.gl === null);
  assert.match(err.message, /Shader compilation/);
}));

/* ---------- options & API ---------- */

test('perturbance: 0 is honoured (data attribute, option, set())', () => {
  const { doc, Ripples } = createEnv({ gl: fakeGL(), html: '<body><div id="a" data-ripples data-ripples-perturbance="0"></div></body>' });
  const [r] = Ripples.autoInit();
  assert.equal(r.perturbance, 0);
  r.set('perturbance', 0.07);
  assert.equal(r.perturbance, 0.07);
  r.set('perturbance', 0);
  assert.equal(r.perturbance, 0);
});

test('dropRadius must stay positive', () => {
  const { doc, Ripples } = createEnv({ gl: fakeGL(), html: '<body><div id="a"></div></body>' });
  const r = new Ripples(doc.getElementById('a'), { dropRadius: 0 });
  assert.equal(r.dropRadius, 30);
  r.set('dropRadius', -5);
  assert.equal(r.dropRadius, 30);
});

test('init() always returns an array; autoInit finds [data-ripples]', () => {
  const { doc, Ripples } = createEnv({ gl: fakeGL(), html: '<body><div data-ripples></div><img data-ripples src="a.jpg"><div id="p"></div></body>' });
  const a = Ripples.autoInit();
  assert.ok(Array.isArray(a) && a.length === 2);
  assert.equal(Ripples.autoInit().length, 0, 'second call skips initialised elements');
  assert.equal(Ripples.init('#p').length, 1);
  assert.equal(Ripples.init('.none').length, 0);
  assert.equal(Ripples.init(doc.querySelectorAll('#p')).length, 1);
});

test('data-auto-init on the script tag runs autoInit; no attribute = no side effect', async () => {
  const { JSDOM } = await import('jsdom');
  const { UMD } = await import('./helpers.mjs');
  for (const attr of [false, true]) {
    const dom = new JSDOM('<!doctype html><body><div data-ripples></div></body>', { runScripts: 'dangerously', pretendToBeVisual: true });
    const w = dom.window;
    let probes = 0;
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.HTMLCanvasElement.prototype.getContext = () => { probes++; return null; };
    const s = w.document.createElement('script');
    if (attr) s.setAttribute('data-auto-init', '');
    s.textContent = UMD;
    const w0 = console.warn; console.warn = () => {};
    w.document.body.appendChild(s);
    await wait(40);
    console.warn = w0;
    assert.equal(probes > 0, attr);
  }
});

test('set(): unknown property warns', () => {
  const { doc, Ripples } = createEnv({ gl: fakeGL(), html: '<body><div id="a"></div></body>' });
  const r = new Ripples(doc.getElementById('a'));
  const w0 = console.warn; let msg = '';
  console.warn = (m) => (msg = String(m));
  r.set('bogus', 1);
  console.warn = w0;
  assert.match(msg, /unknown or read-only/);
});

/* ---------- lazy context, lifecycle ---------- */

test('lazy: no context until the first interaction; ready fires after the image upload', async () => {
  const gl = fakeGL();
  const { w, doc, Ripples, stats } = createEnv({ gl, html: '<body><div id="a"></div></body>' });
  let ready = 0;
  const div = doc.getElementById('a');
  const r = new Ripples(div, { onReady: () => ready++, imageUrl: 'a.jpg' });
  assert.equal(r.gl, null);
  assert.equal(stats.contexts, 1, 'only the capability probe exists');
  ptr(w, div, 'pointerenter');
  assert.ok(r.gl);
  assert.equal(stats.contexts, 2);
  await wait(10);
  assert.equal(ready, 1);
  for (let i = 0; i < 5; i++) ptr(w, div, 'pointermove', 10 + i * 30, 20);
  assert.ok(r.hasActiveRipples);
  await wait(60);
  assert.ok(gl.__calls.draw > 0);
});

test('CSSOM-only styling, decorative canvas, no injected <style>', () => {
  const { doc, Ripples } = createEnv({ gl: fakeGL(), html: '<body><div id="a"></div></body>' });
  const div = doc.getElementById('a');
  new Ripples(div);
  assert.equal(div.style.isolation, 'isolate');
  assert.equal(div.style.position, 'relative');
  assert.equal(div.querySelector('canvas').getAttribute('aria-hidden'), 'true');
  assert.equal(doc.querySelector('style'), null);
});

test('show() before the image is uploaded does not blank the original', () => {
  const { doc, Ripples } = createEnv({ gl: fakeGL(), html: '<body><img id="i" src="a.jpg"></body>' });
  const img = doc.getElementById('i');
  const r = new Ripples(img);
  r.hide();
  r.show();
  assert.notEqual(img.style.opacity, '0');
});

test('pause(): the loop sleeps instead of spinning rAF; play() resumes', async () => {
  const { w, doc, Ripples } = createEnv({ gl: fakeGL(), html: '<body><div id="a"></div></body>' });
  const r = new Ripples(doc.getElementById('a'), { lazy: false });
  r.drop(10, 10);
  r.pause();
  await wait(60);
  assert.ok(r.isSleeping && !r.rafId);
  r.play();
  await wait(30);
  assert.ok(r.hasActiveRipples);
});

test('getBoundingClientRect is read once per frame, not per pointer event', () => {
  const { w, doc, Ripples } = createEnv({ gl: fakeGL(), html: '<body><div id="a"></div></body>' });
  const div = doc.getElementById('a');
  const r = new Ripples(div, { lazy: false });
  let reads = 0;
  const orig = div.getBoundingClientRect.bind(div);
  div.getBoundingClientRect = () => { reads++; return orig(); };
  r._rect = null;
  for (let i = 0; i < 10; i++) ptr(w, div, 'pointermove', 20 + i * 30, 50);
  assert.equal(reads, 1);
});

test('prefers-reduced-motion changes apply live and revert', () => {
  const { doc, Ripples, mq } = createEnv({ gl: fakeGL(), html: '<body><div id="a"></div></body>' });
  const r = new Ripples(doc.getElementById('a'), { perturbance: 0.05 });
  mq.forEach((f) => f({ matches: true }));
  assert.ok(Math.abs(r.perturbance - 0.02) < 1e-9);
  assert.ok(r.damping <= 0.92);
  mq.forEach((f) => f({ matches: false }));
  assert.equal(r.perturbance, 0.05);
  r.destroy();
  assert.equal(mq.length, 0, 'listener removed on destroy');
});

test('destroy(): container fully restored', () => {
  const { doc, Ripples } = createEnv({ gl: fakeGL(), html: '<body><div id="a" style="background-image:url(x.jpg)"></div></body>' });
  const div = doc.getElementById('a');
  const r = new Ripples(div, { lazy: false });
  r.destroy();
  assert.ok(div.style.backgroundImage.includes('x.jpg'));
  assert.equal(div.style.isolation, '');
  assert.equal(div.querySelector('canvas'), null);
});

/* ---------- <img> wrapper ---------- */

test('img: margin moves to the wrapper and is not applied twice', () => {
  const { doc, Ripples } = createEnv({ gl: fakeGL(), html: '<body><div id="box"><img id="i" src="a.jpg" style="margin:10px"></div></body>' });
  const img = doc.getElementById('i');
  const r = new Ripples(img);
  assert.equal(img.parentNode.style.marginTop, '10px');
  assert.equal(img.style.margin, '0px');
  r.destroy();
  assert.equal(img.style.margin, '10px');
  assert.equal(img.parentNode.id, 'box');
});

test('img fill:true stretches inside the wrapper; fill:false leaves the image alone', () => {
  const { doc, Ripples } = createEnv({ gl: fakeGL(), html: '<body><img id="i" src="a.jpg" style="width:300px"></body>' });
  const img = doc.getElementById('i');
  const a = new Ripples(img);
  assert.equal(img.style.width, '100%');
  assert.equal(img.parentNode.style.width, '300px');
  a.destroy();
  assert.equal(img.style.width, '300px');
  const b = new Ripples(img, { fill: false });
  assert.equal(img.style.width, '300px');
  assert.equal(img.parentNode.style.width, 'fit-content');
  b.destroy();
});

/* ---------- textures ---------- */

test('images larger than MAX_TEXTURE_SIZE are downscaled before upload', async () => {
  const gl = fakeGL({ maxTex: 512 });
  const { doc, Ripples, stats } = createEnv({ gl, images: { 'big\\.jpg': [2000, 1000] }, html: '<body><div id="a"></div></body>' });
  const r = new Ripples(doc.getElementById('a'), { lazy: false, imageUrl: 'big.jpg' });
  await wait(10);
  assert.equal(r.backgroundWidth, 512);
  assert.equal(r.backgroundHeight, 256);
  const uploaded = gl.__calls.tex.at(-1).at(-1);
  assert.equal(uploaded.width, 512);
  assert.deepEqual(stats.drawImage.at(-1).slice(1), [0, 0, 512, 256]);
});

test('normal-sized images are uploaded as they are (no canvas copy)', async () => {
  const gl = fakeGL();
  const { w, doc, Ripples } = createEnv({ gl, images: { 'ok\\.jpg': [800, 600] }, html: '<body><div id="a"></div></body>' });
  const r = new Ripples(doc.getElementById('a'), { lazy: false, imageUrl: 'ok.jpg' });
  await wait(10);
  assert.equal(r.backgroundWidth, 800);
  assert.ok(gl.__calls.tex.at(-1).at(-1) instanceof w.Image);
});

test('SVG without intrinsic size: sane aspect, raster sized to the screen (not a fixed 2048+)', async () => {
  const gl = fakeGL();
  const { doc, Ripples, stats } = createEnv({ gl, images: { 'logo\\.svg': [0, 0] }, html: '<body><div id="a"></div></body>' });
  const r = new Ripples(doc.getElementById('a'), { lazy: false, imageUrl: 'logo.svg' });
  await wait(10);
  assert.equal(r.backgroundWidth, 1024);   // jsdom viewport width, dpr 1
  assert.equal(r.backgroundHeight, 512);   // 300x150 default aspect
  assert.deepEqual(stats.drawImage.at(-1).slice(3), [1024, 512]);
});

test('small SVG is rasterised small; growing the element re-rasterises it', async () => {
  const gl = fakeGL();
  const { w, doc, Ripples, stats } = createEnv({ gl, images: { 'icon\\.svg': [100, 50] }, html: '<body><div id="a"></div></body>' });
  const div = doc.getElementById('a');
  let width = 200;
  div.getBoundingClientRect = () => ({ width, height: width / 2, left: 0, top: 0, right: width, bottom: width / 2 });
  const r = new Ripples(div, { lazy: false, imageUrl: 'icon.svg' });
  await wait(10);
  assert.equal(r.backgroundWidth, 256, 'clamped to the minimum raster size');
  const loadsBefore = stats.loaded.length;
  width = 1200;
  r.updateSize();
  await wait(20);
  assert.ok(stats.loaded.length > loadsBefore, 'image requested again');
  assert.equal(r.backgroundWidth, 1200);
});

/* ---------- refresh() ---------- */

test('refresh() picks up a changed CSS background-image', async () => {
  const gl = fakeGL();
  const { doc, Ripples, stats } = createEnv({ gl, html: '<head><style id="st">#c{background-image:url(a.png)}</style></head><body><div id="c"></div></body>' });
  const div = doc.getElementById('c');
  const r = new Ripples(div, { lazy: false });
  await wait(10);
  assert.match(stats.loaded.at(-1), /a\.png$/);
  assert.equal(div.style.backgroundImage, 'none', 'original hidden while the effect is live');
  doc.getElementById('st').textContent = '#c{background-image:url(b.png)}';
  r.refresh();
  await wait(10);
  assert.match(stats.loaded.at(-1), /b\.png$/);
  assert.match(r.imageSource, /b\.png$/);
  assert.equal(div.style.backgroundImage, 'none');
});

/* ---------- context budget ---------- */

test('LRU: more than maxContexts instances -> the least recently used idle one is released', () => {
  const gl = fakeGL();
  const { w, doc, Ripples } = createEnv({ gl, html: '<body><div id="a"></div><div id="b"></div><div id="c"></div></body>' });
  Ripples.maxContexts = 2;
  const [a, b, c] = ['a', 'b', 'c'].map((id) => new Ripples(doc.getElementById(id), { lazy: false }));
  assert.equal(a.gl, null, 'oldest idle instance released');
  assert.ok(b.gl && c.gl);
  assert.equal(Ripples._active.size, 2);
  assert.equal(doc.querySelectorAll('#a canvas').length, 1, 'fresh canvas swapped in');
  ptr(w, doc.getElementById('a'), 'pointerenter');
  assert.ok(a.gl, 'released instance comes back on interaction');
  assert.equal(b.gl, null, 'next LRU victim');
  assert.equal(Ripples._active.size, 2);
});

test('an animating instance is never evicted', () => {
  const { doc, Ripples } = createEnv({ gl: fakeGL(), html: '<body><div id="a"></div><div id="b"></div></body>' });
  Ripples.maxContexts = 1;
  const a = new Ripples(doc.getElementById('a'), { lazy: false });
  a.drop(5, 5);
  const b = new Ripples(doc.getElementById('b'), { lazy: false });
  assert.ok(a.gl && b.gl, 'both stay alive rather than killing a running animation');
});

test('releaseOnIdle: context is freed after the ripples settle, original image shown again', async () => {
  const { doc, Ripples } = createEnv({ gl: fakeGL(), html: '<body><img id="i" src="a.jpg"></body>' });
  const img = doc.getElementById('i');
  const r = new Ripples(img, { lazy: false, releaseDelay: 20 });
  await wait(10);
  assert.equal(img.style.opacity, '0');
  r.drop(5, 5);
  r.activeTime = 4995;
  await wait(150);
  assert.equal(r.gl, null);
  assert.notEqual(img.style.opacity, '0');
  assert.equal(r.destroyed, false);
});

test('releaseOnIdle:false keeps the context', async () => {
  const { doc, Ripples } = createEnv({ gl: fakeGL(), html: '<body><div id="a"></div></body>' });
  const r = new Ripples(doc.getElementById('a'), { lazy: false, releaseDelay: 20, releaseOnIdle: false });
  r.drop(5, 5);
  r.activeTime = 4995;
  await wait(150);
  assert.ok(r.gl);
});

test('prewarm: context is created in an idle moment once the element is visible', async () => {
  const { w, doc, Ripples } = createEnv({ gl: fakeGL(), io: true, html: '<body><div id="a"></div></body>' });
  const r = new Ripples(doc.getElementById('a'), { prewarm: true });
  assert.equal(r.gl, null);
  w.__io([{ isIntersecting: true }]);
  await wait(300);
  assert.ok(r.gl);
});

/* ---------- <picture>, <canvas>, <video> ---------- */

test('picture: wraps <picture> (keeping <source> + <img> intact) and tracks currentSrc changes', async () => {
  const gl = fakeGL();
  const { w, doc, Ripples, stats } = createEnv({
    gl,
    html: '<body><div id="box"><picture id="p"><source srcset="hero.webp"><img id="i" src="hero.jpg" style="margin:12px;width:300px"></picture></div></body>',
  });
  const pic = doc.getElementById('p');
  const img = doc.getElementById('i');
  let cur = 'https://example.com/hero.webp';
  Object.defineProperty(img, 'currentSrc', { get: () => cur, configurable: true });

  const r = new Ripples(pic, { lazy: false });
  await wait(10);
  assert.equal(img.parentNode, pic, '<img> stays inside <picture>');
  assert.equal(pic.parentNode.style.marginTop, '12px');
  assert.equal(img.style.opacity, '0');
  assert.match(stats.loaded.at(-1), /hero\.webp$/);

  cur = 'https://example.com/hero-lg.webp';
  img.dispatchEvent(new w.Event('load'));
  await wait(10);
  assert.match(stats.loaded.at(-1), /hero-lg\.webp$/);

  r.destroy();
  assert.equal(pic.parentNode.id, 'box');
  assert.equal(img.parentNode, pic);
  assert.equal(img.style.margin, '12px');
  assert.equal(img.style.width, '300px');
});

test('picture: targeting <img> inside <picture> still wraps <picture> safely', async () => {
  const { doc, Ripples } = createEnv({
    gl: fakeGL(),
    html: '<body><picture id="p"><source srcset="a.webp"><img id="i" src="a.jpg"></picture></body>',
  });
  const pic = doc.getElementById('p');
  const img = doc.getElementById('i');
  const r = new Ripples(img);
  assert.equal(img.parentNode, pic);
  assert.equal(pic.parentNode, r.element);
  r.destroy();
  assert.equal(pic.parentNode, doc.body);
});

test('canvas: uploads HTMLCanvasElement, uses texSubImage2D in live mode, supports live:false + refresh()', async () => {
  const gl = fakeGL();
  const { w, doc, Ripples } = createEnv({
    gl,
    html: '<body><canvas id="c" width="320" height="180" style="margin:8px"></canvas></body>',
  });
  const canvas = doc.getElementById('c');
  let ready = 0;
  canvas.addEventListener('ripples:ready', () => ready++);
  const r = new Ripples(canvas, { lazy: false });
  await wait(35);
  assert.equal(ready, 1);
  assert.equal(r.backgroundWidth, 320);
  assert.equal(r.backgroundHeight, 180);
  assert.equal(canvas.style.opacity, '0');
  assert.equal(gl.__calls.mipmaps, 0, 'live canvas skips mipmaps');
  assert.equal(gl.__calls.tex.at(-1).at(-1), canvas);
  assert.ok(gl.__calls.texSub.length > 0, 'live canvas updates frames via texSubImage2D');

  r.set('live', false);
  const subCount = gl.__calls.texSub.length;
  const texCount = gl.__calls.tex.length;
  await wait(40);
  assert.equal(r.isSleeping, true, 'static mode sleeps when no ripples are active');
  assert.equal(gl.__calls.texSub.length, subCount);

  r.refresh();
  assert.equal(gl.__calls.tex.length, texCount + 1, 'refresh() uploads a new frame');

  r.destroy();
  assert.equal(canvas.parentNode, doc.body);
  assert.equal(canvas.style.margin, '8px');
  assert.notEqual(canvas.style.opacity, '0');
  assert.ok(w.HTMLCanvasElement);
});

test('video: waits for loadeddata, streams live frames while playing, sleeps on pause, never detaches on release', async () => {
  const gl = fakeGL();
  const { w, doc, Ripples } = createEnv({
    gl,
    html: '<body><video id="v" src="clip.mp4"></video></body>',
  });
  const video = doc.getElementById('v');
  let readyState = 0, vw = 0, vh = 0, paused = false, currentTime = 0;
  Object.defineProperties(video, {
    readyState: { get: () => readyState, configurable: true },
    videoWidth: { get: () => vw, configurable: true },
    videoHeight: { get: () => vh, configurable: true },
    paused: { get: () => paused, configurable: true },
    ended: { get: () => false, configurable: true },
    currentTime: { get: () => currentTime, configurable: true },
  });

  let ready = 0;
  const r = new Ripples(video, { lazy: false, releaseDelay: 20, onReady: () => ready++ });
  assert.equal(ready, 0);
  assert.notEqual(video.style.opacity, '0', 'video stays visible until first frame loads');

  readyState = 2; vw = 640; vh = 360; currentTime = 0.1;
  video.dispatchEvent(new w.Event('loadeddata'));
  assert.equal(ready, 1);
  assert.equal(r.backgroundWidth, 640);
  assert.equal(video.style.opacity, '0');
  assert.equal(gl.__calls.tex.at(-1).at(-1), video);

  currentTime = 0.2;
  await wait(35);
  assert.ok(gl.__calls.texSub.length > 0, 'playing video updates via texSubImage2D');

  const subBeforePause = gl.__calls.texSub.length;
  paused = true;
  video.dispatchEvent(new w.Event('pause'));
  await wait(35);
  assert.equal(r.isSleeping, true, 'loop sleeps when video pauses without active ripples');
  assert.equal(gl.__calls.texSub.length, subBeforePause + 1);

  let removed = false;
  const origRemove = video.remove.bind(video);
  video.remove = () => { removed = true; return origRemove(); };
  r.release();
  assert.equal(removed, false, 'release() does not detach <video> from DOM');
  assert.notEqual(video.style.opacity, '0');

  r.destroy();
  assert.equal(video.parentNode, doc.body);
});

test('imageUrl with video extension creates and cleans up owned <video>', async () => {
  const gl = fakeGL();
  const { w, doc, Ripples } = createEnv({ gl, html: '<body><div id="hero"></div></body>' });
  const r = new Ripples(doc.getElementById('hero'), { lazy: false, imageUrl: 'ocean.mp4?v=1' });
  const v = r._ownedVideo;
  assert.ok(v && v.tagName === 'VIDEO');
  assert.equal(v.muted, true);
  assert.equal(v.loop, true);
  assert.equal(v.playsInline, true);

  Object.defineProperties(v, {
    readyState: { get: () => 2, configurable: true },
    videoWidth: { get: () => 1280, configurable: true },
    videoHeight: { get: () => 720, configurable: true },
    paused: { get: () => false, configurable: true },
    ended: { get: () => false, configurable: true },
    currentTime: { get: () => 0.5, configurable: true },
  });
  v.dispatchEvent(new w.Event('loadeddata'));
  assert.equal(r.backgroundWidth, 1280);
  assert.equal(r.isAutoAspectRatio, true);
  assert.equal(r.element.style.aspectRatio, '1280 / 720');

  r.set('imageUrl', 'still.jpg');
  assert.equal(r._ownedVideo, null);
  await wait(10);
  assert.equal(r.backgroundWidth, 400);
  r.destroy();
});

test('damping: 0 and speed: 0 clamp to documented minimums; individual inline margins restore on destroy', () => {
  const { doc, Ripples } = createEnv({ gl: fakeGL(), html: '<body><img id="i" src="a.jpg" style="margin-top:10px;margin-left:4px"></body>' });
  const img = doc.getElementById('i');
  const r = new Ripples(img, { damping: 0, speed: 0 });
  assert.equal(r.damping, 0.8);
  assert.equal(r.speed, 0.1);
  r.destroy();
  assert.equal(img.style.marginTop, '10px');
  assert.equal(img.style.marginLeft, '4px');
  assert.equal(img.style.marginBottom, '');
});

test('isRemoteUrl accurately checks origin for prefix-matching and protocol-relative URLs', async () => {
  const { doc, Ripples, stats } = createEnv({ gl: fakeGL(), html: '<body><div id="a"></div></body>' });
  const r = new Ripples(doc.getElementById('a'), { lazy: false, imageUrl: 'https://example.com/local.jpg' });
  await wait(10);
  assert.equal(stats.crossOrigins.at(-1), undefined);

  r.set('imageUrl', 'https://example.com.evil.com/remote.jpg');
  await wait(10);
  assert.equal(stats.crossOrigins.at(-1), 'anonymous');

  r.set('imageUrl', '//cdn.example.com/proto-rel.jpg');
  await wait(10);
  assert.equal(stats.crossOrigins.at(-1), 'anonymous');
  r.destroy();
});

test('img activate() loads image and emits ready once (no double load)', async () => {
  const gl = fakeGL();
  const { doc, Ripples, stats } = createEnv({ gl, html: '<body><img id="i" src="single.jpg"></body>' });
  const img = doc.getElementById('i');
  let ready = 0, evtReady = 0;
  img.addEventListener('ripples:ready', () => evtReady++);
  const r = new Ripples(img, { lazy: false, onReady: () => ready++ });
  await wait(20);
  assert.equal(stats.loaded.length, 1);
  assert.equal(ready, 1);
  assert.equal(evtReady, 1);
  r.destroy();
});

test('300x150 element at dpr:1 still initializes size and boundaries', async () => {
  const gl = fakeGL();
  const { doc, Ripples } = createEnv({ gl, html: '<body><div id="a" style="background-image:url(x.jpg)"></div></body>' });
  const div = doc.getElementById('a');
  div.getBoundingClientRect = () => ({ width: 300, height: 150, left: 0, top: 0, right: 300, bottom: 150 });
  const r = new Ripples(div, { lazy: false, dpr: 1 });
  await wait(10);
  assert.equal(r.canvas.width, 300);
  assert.equal(r.canvas.height, 150);
  assert.equal(r.lastClientWidth, 300);
  assert.equal(r.lastClientHeight, 150);
  assert.equal(r.boundariesDirty, false);
  r.destroy();
});

test('prewarm re-arms if element leaves viewport before idle callback fires', async () => {
  const { w, doc, Ripples } = createEnv({ gl: fakeGL(), io: true, html: '<body><div id="a"></div></body>' });
  const r = new Ripples(doc.getElementById('a'), { prewarm: true });
  w.__io([{ isIntersecting: true }]);
  w.__io([{ isIntersecting: false }]);
  await wait(250);
  assert.equal(r.gl, null, 'does not activate while offscreen');
  w.__io([{ isIntersecting: true }]);
  await wait(250);
  assert.ok(r.gl, 'activates after returning to viewport');
  r.destroy();
});

test('init(null) and init("") return [] without running autoInit', () => {
  const { w, doc, Ripples } = createEnv({ gl: fakeGL(), html: '<body><div id="d" data-ripples></div></body>' });
  const a = Ripples.init(null);
  const b = Ripples.init('');
  assert.ok(w.Array.isArray(a) && a.length === 0);
  assert.ok(w.Array.isArray(b) && b.length === 0);
  assert.equal(doc.getElementById('d')._ripples, undefined);
  assert.equal(Ripples.init().length, 1, 'init() with undefined still runs autoInit');
});

test('RG16F is preferred over RGBA16F and flat frames skip gradient pass', async () => {
  const gl = fakeGL();
  const { doc, Ripples } = createEnv({ gl, html: '<body><div id="a"></div></body>' });
  const r = new Ripples(doc.getElementById('a'), { lazy: false, imageUrl: 'a.jpg' });
  assert.equal(r.glConfig.internalFormat, gl.RG16F);
  await wait(10);
  const drawsOnFlat = gl.__calls.draw;
  r.renderSingleFrame();
  assert.equal(gl.__calls.draw, drawsOnFlat + 1, 'flat frame renders in 1 draw pass (no gradient pass)');
  r.drop(10, 10);
  await wait(40);
  assert.ok(gl.__calls.draw > drawsOnFlat + 2, 'active ripples run simulation + gradient + render passes');
  r.destroy();
});

test('isAutoAspectRatio updates on imageUrl change and restores inline styles on destroy', async () => {
  const gl = fakeGL();
  const { doc, Ripples } = createEnv({
    gl,
    images: { 'wide\\.jpg': [1280, 720], 'square\\.jpg': [400, 400] },
    html: '<body><div id="a" style="display:inline-block;width:50%"></div></body>',
  });
  const div = doc.getElementById('a');
  const r = new Ripples(div, { lazy: false, imageUrl: 'wide.jpg' });
  await wait(10);
  assert.equal(r.isAutoAspectRatio, true);
  assert.equal(div.style.aspectRatio, '1280 / 720');
  r.set('imageUrl', 'square.jpg');
  await wait(10);
  assert.equal(div.style.aspectRatio, '400 / 400');
  r.destroy();
  assert.equal(div.style.display, 'inline-block');
  assert.equal(div.style.width, '50%');
  assert.equal(div.style.aspectRatio, '');
});

test('presets: option, data attribute, precedence, set(), and unknown warning', () => {
  const { doc, Ripples } = createEnv({
    gl: fakeGL(),
    html: '<body><div id="a" data-ripples data-ripples-preset="calm" data-ripples-speed="1.5"></div><div id="b"></div></body>',
  });
  assert.equal(Ripples.VERSION, pkg.version);
  assert.ok(Object.isFrozen(Ripples.PRESETS));
  assert.equal(Ripples.DEFAULTS.specular, 0.2);

  const [a] = Ripples.autoInit();
  assert.equal(a.dropRadius, Ripples.PRESETS.calm.dropRadius);
  assert.equal(a.perturbance, Ripples.PRESETS.calm.perturbance);
  assert.equal(a.speed, 1.5, 'individual data attribute overrides preset');

  const b = new Ripples(doc.getElementById('b'), { lazy: false, preset: 'glossy', perturbance: 0.08 });
  assert.equal(b.dropRadius, Ripples.PRESETS.glossy.dropRadius);
  assert.equal(b.specularIntensity, Ripples.PRESETS.glossy.specular);
  assert.equal(b.perturbance, 0.08, 'explicit option overrides preset');

  b.set('preset', 'viscous');
  assert.equal(b.dropRadius, Ripples.PRESETS.viscous.dropRadius);
  assert.equal(b.perturbance, Ripples.PRESETS.viscous.perturbance);
  assert.equal(b.damping, Ripples.PRESETS.viscous.damping);
  assert.equal(b.speed, Ripples.PRESETS.viscous.speed);
  assert.equal(b.specularIntensity, Ripples.PRESETS.viscous.specular);

  const w0 = console.warn; let msg = '';
  console.warn = (m) => (msg = String(m));
  b.set('preset', 'nonexistent');
  console.warn = w0;
  assert.match(msg, /Unknown preset/);
  assert.equal(b.dropRadius, Ripples.PRESETS.viscous.dropRadius, 'unknown preset keeps current values');

  const c = new Ripples(doc.getElementById('a'), { preset: 'subtle' });
  assert.equal(c.perturbance, Ripples.PRESETS.subtle.perturbance, 'options.preset overrides data attributes');
  const d = new Ripples(doc.getElementById('a'), { preset: null });
  assert.equal(d.dropRadius, Ripples.DEFAULTS.dropRadius, 'preset: null cancels data-ripples-preset');

  a.destroy();
  b.destroy();
  c.destroy();
  d.destroy();
});

test('lockTouch: disabled by default, toggles touch-action: none, and restores on destroy', () => {
  const { doc, Ripples } = createEnv({ gl: fakeGL(), html: '<body><div id="a"></div><div id="b"></div></body>' });
  const a = doc.getElementById('a');
  const b = doc.getElementById('b');
  a.style.touchAction = 'pan-y';

  const ra = new Ripples(a);
  assert.equal(ra.lockTouch, false);
  assert.equal(a.style.touchAction, 'pan-y');
  ra.set('lockTouch', true);
  assert.equal(a.style.touchAction, 'none');
  ra.set('interactive', false);
  assert.equal(a.style.touchAction, 'pan-y', 'disabling interactive releases touch-action lock');
  ra.set('interactive', true);
  assert.equal(a.style.touchAction, 'none');
  ra.destroy();
  assert.equal(a.style.touchAction, 'pan-y');

  const rb = new Ripples(b, { lockTouch: true });
  assert.equal(b.style.touchAction, 'none');
  rb.destroy();
  assert.equal(b.style.touchAction, '');
});

test('getEffectiveRadius scales symmetrically by longest side and clamps to [0.5, 1.3]', () => {
  const { doc, Ripples } = createEnv({ gl: fakeGL(), html: '<body><div id="a"></div></body>' });
  const r = new Ripples(doc.getElementById('a'));
  const landscape = r.getEffectiveRadius(30, Math.max(844, 390));
  const portrait = r.getEffectiveRadius(30, Math.max(390, 844));
  assert.equal(landscape, portrait);
  assert.ok(Math.abs(portrait - 30 * (844 / 1200)) < 1e-9);
  assert.equal(r.getEffectiveRadius(30, 200), 15);
  assert.equal(r.getEffectiveRadius(30, 2400), 39);
  r.destroy();
});
