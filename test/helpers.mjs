import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

export const UMD = readFileSync(new URL('../dist/ripples.umd.js', import.meta.url), 'utf8');
export const UMD_MIN = readFileSync(new URL('../dist/ripples.umd.min.js', import.meta.url), 'utf8');
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A WebGL2 stand-in: enough surface for the plugin's control flow (no pixels are produced).
export function fakeGL({ badShader = false, maxTex = 4096 } = {}) {
  const consts = {};
  let n = 1;
  const C = (k) => (consts[k] ??= n++);
  const calls = { draw: 0, tex: [], texSub: [], mipmaps: 0, lost: false };
  const base = {
    getShaderParameter: () => !badShader,
    getShaderInfoLog: () => 'boom',
    getProgramParameter: (p, k) => (k === C('ACTIVE_UNIFORMS') ? 0 : true),
    getProgramInfoLog: () => '',
    getActiveUniform: () => ({ name: 'x' }),
    getUniformLocation: () => ({}),
    getParameter: (k) => (k === C('MAX_TEXTURE_SIZE') ? maxTex : 0),
    checkFramebufferStatus: () => C('FRAMEBUFFER_COMPLETE'),
    getExtension: () => ({ loseContext() { calls.lost = true; } }),
    drawArrays: () => { calls.draw++; },
    texImage2D: (...a) => { calls.tex.push(a); },
    texSubImage2D: (...a) => { calls.texSub.push(a); },
    generateMipmap: () => { calls.mipmaps++; },
    createShader: () => ({}), createProgram: () => ({}), createTexture: () => ({}),
    createFramebuffer: () => ({}), createBuffer: () => ({}), createVertexArray: () => ({}),
  };
  const gl = new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'symbol') return undefined;
      if (/^[A-Z][A-Z0-9_]*$/.test(k)) return C(k);
      return () => {};
    },
  });
  gl.__calls = calls;
  return gl;
}

/**
 * Fresh jsdom window with the UMD build evaluated in it.
 * images: { 'regex source': [naturalWidth, naturalHeight] } for the mocked Image class.
 */
export function createEnv({ html = '<body></body>', gl = null, reduced = false, images = {}, source = UMD, io = false } = {}) {
  const dom = new JSDOM(`<!doctype html>${html}`, { pretendToBeVisual: true, runScripts: 'outside-only', url: 'https://example.com/' });
  const w = dom.window;
  const mq = [];
  w.matchMedia = () => ({
    matches: reduced,
    addEventListener: (_, f) => mq.push(f),
    removeEventListener: (_, f) => { const i = mq.indexOf(f); if (i >= 0) mq.splice(i, 1); },
  });
  const stats = { contexts: 0, drawImage: [], loaded: [], crossOrigins: [] };
  w.HTMLCanvasElement.prototype.getContext = function (type) {
    if (type === 'webgl2' && gl) { stats.contexts++; return gl; }
    if (type === '2d') return { imageSmoothingQuality: '', clearRect: () => {}, drawImage: (...a) => stats.drawImage.push(a) };
    return null;
  };
  if (w.HTMLMediaElement) {
    w.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
    w.HTMLMediaElement.prototype.pause = function () {};
    w.HTMLMediaElement.prototype.load = function () {};
  }
  const sizeFor = (src) => {
    for (const [re, size] of Object.entries(images)) if (new RegExp(re).test(src)) return size;
    return [400, 300];
  };
  w.Image = class {
    set src(v) {
      this._s = v;
      stats.loaded.push(v);
      stats.crossOrigins.push(this.crossOrigin);
      const [nw, nh] = sizeFor(v);
      setTimeout(() => {
        this.naturalWidth = this.width = nw;
        this.naturalHeight = this.height = nh;
        if (this.onload) this.onload();
      }, 0);
    }
    get src() { return this._s; }
  };
  if (io) w.IntersectionObserver = class { constructor(cb) { w.__io = cb; } observe() {} disconnect() {} };
  w.eval(source);
  return { w, doc: w.document, Ripples: w.Ripples, mq, stats };
}

export const ptr = (w, el, type, x = 0, y = 0) => el.dispatchEvent(new w.MouseEvent(type, { clientX: x, clientY: y }));
