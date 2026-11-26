/**
 * Ripples.js — WebGL 2 water ripple effect for <img>, <picture>, <video>, <canvas>, and CSS backgrounds.
 * Zero dependencies. MIT License.
 */

const BLANK_PIXEL = new Uint8Array([0, 0, 0, 0]);

// Fixed 60 Hz simulation step
const STEP_MS = 1000 / 60;
const STEP_TOLERANCE = 0.15;      // absorbs vsync timestamp jitter (avoids 0/2-step stutter at 60 Hz)
const MAX_FRAME_MS = 100;         // after a stall / tab switch never "catch up" more than this
const MAX_STEPS_PER_FRAME = 8;
const SETTLE_DECAY_START_MS = 3500; // autoPause: damping starts to ramp up
const SETTLE_END_MS = 5000;         // autoPause: simulation sleeps
const SETTLE_FADE = 0.10;           // autoPause: per-step height relaxation reached at the end of the window
const MAX_DROPS_PER_PASS = 32;      // must match MAX_DROPS in DROP_FS
const MAX_QUEUED_DROPS = 512;
const TRAIL_SPACING = 0.5;          // max gap between interpolated drops, in drop radii
const MAX_TRAIL_DROPS = 48;

function parseDataOptions(element) {
  const options = {};
  if (!element || !element.dataset) return options;

  for (const key in element.dataset) {
    if (key.startsWith('ripples') && key.length > 7) {
      const optionKey = key.charAt(7).toLowerCase() + key.slice(8);
      const rawVal = element.dataset[key];
      let val;
      try {
        val = JSON.parse(rawVal);
      } catch (e) {
        val = rawVal; // not JSON: keep as a plain string (e.g. crossOrigin="anonymous")
      }
      options[optionKey] = val;
    }
  }

  const rawRipples = element.getAttribute('data-ripples');
  if (rawRipples && rawRipples.trim().startsWith('{')) {
    try {
      Object.assign(options, JSON.parse(rawRipples));
    } catch (e) {
      console.warn('[Ripples] Invalid JSON in data-ripples attribute:', e.message);
    }
  }

  return options;
}

const toNumber = (value, fallback) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
};

// Positive numbers only (a zero/negative radius would divide by zero in the drop shader)
const toPositive = (value, fallback) => {
  const n = parseFloat(value);
  return n > 0 ? n : fallback;
};

const parseDamping = (v) => Math.min(Math.max(toNumber(v, 0.975), 0.8), 0.999);
const parseSpeed = (v) => Math.max(toNumber(v, 1), 0.1);
const parseSpecular = (v) => (v === true ? 1.0 : toNumber(v, 0.0));
const parseLive = (v) => (v === true || v === false ? v : 'auto');

const MARGIN_SIDES = ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'];

function saveMargins(el) {
  return {
    shorthand: el.style.margin,
    sides: MARGIN_SIDES.map(p => el.style[p])
  };
}

function restoreMargins(el, saved) {
  if (!saved) return;
  if (saved.shorthand) {
    el.style.margin = saved.shorthand;
    return;
  }
  el.style.margin = '';
  for (let i = 0; i < MARGIN_SIDES.length; i++) {
    if (saved.sides[i]) el.style[MARGIN_SIDES[i]] = saved.sides[i];
  }
}

const isVideoUrl = (url) =>
  typeof url === 'string' && (/\.(mp4|webm|ogv|mov|m4v)($|\?)/i.test(url) || /^data:video\//i.test(url));

const isRemoteUrl = (url) => {
  if (typeof url !== 'string' || !/^(https?:)?\/\//i.test(url)) return false;
  try {
    return new URL(url, window.location.href).origin !== window.location.origin;
  } catch (e) {
    return true;
  }
};

function extractUrl(value) {
  if (!value || value === 'none') return null;
  // Handles "double", 'single' and unquoted url(); inner quotes of data-URIs survive
  const match = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)]*))\s*\)/i.exec(value);
  if (!match) return null;
  const raw = match[1] !== undefined ? match[1] : (match[2] !== undefined ? match[2] : match[3]);
  return raw.replace(/\\(.)/g, '$1').trim() || null;
}

function enableFloatExtensions(gl) {
  gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('EXT_color_buffer_half_float');
}

function createRenderTarget(gl, size, config, filter) {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  configureTexture(gl, filter);
  gl.texImage2D(gl.TEXTURE_2D, 0, config.internalFormat, size, size, 0, config.format, config.type, null);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  return { texture, framebuffer };
}

function initWebGL2(canvas, cachedConfig = null) {
  let gl;
  try {
    gl = canvas.getContext('webgl2', {
      alpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      preserveDrawingBuffer: false,
      powerPreference: 'default'
    });
  } catch (e) {
    console.warn('[Ripples] getContext("webgl2") threw:', e && e.message);
    return null;
  }

  if (!gl) {
    console.warn('[Ripples] WebGL 2.0 is not supported in this browser.');
    return null;
  }

  enableFloatExtensions(gl);

  if (cachedConfig) {
    return { gl, config: cachedConfig };
  }

  // Probe half-float render target (RG16F first to halve VRAM/bandwidth, RGBA16F as fallback).
  // NOTE: 16-bit float textures are always linearly filterable in WebGL 2
  // (only 32-bit float needs OES_texture_float_linear).
  const candidates = [
    { internalFormat: gl.RG16F, format: gl.RG, type: gl.HALF_FLOAT },
    { internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT }
  ];

  const testTex = gl.createTexture();
  const testFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, testFbo);
  gl.bindTexture(gl.TEXTURE_2D, testTex);
  configureTexture(gl, gl.NEAREST);

  let chosen = null;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, c.internalFormat, 32, 32, 0, c.format, c.type, null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, testTex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
        chosen = c;
        break;
      }
    } catch (e) { /* format not renderable: try the next candidate */ }
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.deleteTexture(testTex);
  gl.deleteFramebuffer(testFbo);

  if (!chosen) {
    console.warn('[Ripples] WebGL 2 float/half-float framebuffers not supported.');
    return null;
  }

  return { gl, config: chosen };
}

function createProgram(gl, vertexSource, fragmentSource) {
  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const err = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('Shader compilation error: ' + err);
    }
    return shader;
  }

  const program = gl.createProgram();
  const vs = compile(gl.VERTEX_SHADER, vertexSource);
  const fs = compile(gl.FRAGMENT_SHADER, fragmentSource);

  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const err = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error('Program link error: ' + err);
  }

  const locations = {};
  const numUniforms = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < numUniforms; i++) {
    const info = gl.getActiveUniform(program, i);
    locations[info.name] = gl.getUniformLocation(program, info.name);
  }

  return { id: program, locations };
}

function configureTexture(gl, filter) {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

const QUAD_VS = `#version 300 es
precision highp float;
in vec2 vertex;
out vec2 coord;
void main() {
coord = vertex * 0.5 + 0.5;
gl_Position = vec4(vertex, 0.0, 1.0);
}`;

// Applies up to MAX_DROPS drops in a single pass (additive, so identical to applying them one by one)
const DROP_FS = `#version 300 es
precision highp float;
const float PI = 3.141592653589793;
const int MAX_DROPS = 32;
uniform sampler2D uTexture;
uniform vec4 drops[MAX_DROPS]; // xy = centre (sim uv), z = radius (sim uv), w = strength
uniform int dropCount;
in vec2 coord;
out vec4 fragColor;

void main() {
vec4 info = texture(uTexture, coord);
float added = 0.0;
for (int i = 0; i < dropCount; i++) {
  vec4 d = drops[i];
  float k = max(0.0, 1.0 - length(d.xy - coord) / d.z);
  k = 0.5 - cos(k * PI) * 0.5;
  added += k * d.w;
}
info.r += added;
fragColor = info;
}`;

// Isotropic 9-point Laplacian (0.5 * laplacian gives rounder wavefronts and stability limit 2.67).
const UPDATE_FS = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform float damping;
uniform float fade;
out vec4 fragColor;

void main() {
ivec2 p = ivec2(gl_FragCoord.xy);
ivec2 maxP = textureSize(uTexture, 0) - 1;
ivec2 zero = ivec2(0);

vec4 info = texelFetch(uTexture, p, 0);
float axis =
  texelFetch(uTexture, clamp(p + ivec2(-1,  0), zero, maxP), 0).r +
  texelFetch(uTexture, clamp(p + ivec2( 1,  0), zero, maxP), 0).r +
  texelFetch(uTexture, clamp(p + ivec2( 0, -1), zero, maxP), 0).r +
  texelFetch(uTexture, clamp(p + ivec2( 0,  1), zero, maxP), 0).r;
float diag =
  texelFetch(uTexture, clamp(p + ivec2(-1, -1), zero, maxP), 0).r +
  texelFetch(uTexture, clamp(p + ivec2( 1, -1), zero, maxP), 0).r +
  texelFetch(uTexture, clamp(p + ivec2(-1,  1), zero, maxP), 0).r +
  texelFetch(uTexture, clamp(p + ivec2( 1,  1), zero, maxP), 0).r;

float laplacian = (4.0 * axis + diag - 20.0 * info.r) / 6.0;
info.g += laplacian * 0.5;
info.g *= damping;
info.r += info.g;
info.r *= fade; // 1.0 normally; < 1.0 only while the simulation is settling to sleep
fragColor = info;
}`;

// Central-difference gradient of the height field, computed once per frame at simulation
// resolution (256x256 by default: practically free). Exact texel fetches, clamp-to-edge.
const GRADIENT_FS = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
out vec4 fragColor;

void main() {
ivec2 p = ivec2(gl_FragCoord.xy);
ivec2 maxP = textureSize(uTexture, 0) - 1;
float hL = texelFetch(uTexture, ivec2(max(p.x - 1, 0), p.y), 0).r;
float hR = texelFetch(uTexture, ivec2(min(p.x + 1, maxP.x), p.y), 0).r;
float hD = texelFetch(uTexture, ivec2(p.x, max(p.y - 1, 0)), 0).r;
float hU = texelFetch(uTexture, ivec2(p.x, min(p.y + 1, maxP.y)), 0).r;
fragColor = vec4(hR - hL, hU - hD, 0.0, 0.0);
}`;

const RENDER_VS = `#version 300 es
precision highp float;
in vec2 vertex;
uniform vec2 topLeft;
uniform vec2 bottomRight;
uniform vec2 containerRatio;
out vec2 ripplesCoord;
out vec2 backgroundCoord;

void main() {
backgroundCoord = mix(topLeft, bottomRight, vertex * 0.5 + 0.5);
backgroundCoord.y = 1.0 - backgroundCoord.y;
ripplesCoord = vec2(vertex.x, -vertex.y) * containerRatio * 0.5 + 0.5;
gl_Position = vec4(vertex.x, -vertex.y, 0.0, 1.0);
}`;

const RENDER_FS = `#version 300 es
precision highp float;
uniform sampler2D samplerBackground;
uniform sampler2D samplerGradient;
uniform float deltaSq;
uniform float perturbance;
uniform float specular;
uniform float hasWaves;
in vec2 ripplesCoord;
in vec2 backgroundCoord;
out vec4 fragColor;

const vec2 LIGHT_DIR = vec2(-0.5144957554, 0.8574929257); // normalize(vec2(-0.6, 1.0))

// Bicubic Catmull-Rom sampling in 9 bilinear taps. The gradient field becomes C1-continuous,
// so strong waves no longer show the texel grid (faceting / pixelation) after upscaling.
vec2 sampleCatmullRom(sampler2D tex, vec2 uv) {
vec2 texSize = vec2(textureSize(tex, 0));
vec2 samplePos = uv * texSize;
vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
vec2 f = samplePos - texPos1;

vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
vec2 w3 = f * f * (-0.5 + 0.5 * f);

vec2 w12 = w1 + w2;
vec2 offset12 = w2 / w12;

vec2 p0 = (texPos1 - 1.0) / texSize;
vec2 p3 = (texPos1 + 2.0) / texSize;
vec2 p12 = (texPos1 + offset12) / texSize;

vec2 result = vec2(0.0);
result += texture(tex, vec2(p0.x,  p0.y )).rg * (w0.x  * w0.y);
result += texture(tex, vec2(p12.x, p0.y )).rg * (w12.x * w0.y);
result += texture(tex, vec2(p3.x,  p0.y )).rg * (w3.x  * w0.y);

result += texture(tex, vec2(p0.x,  p12.y)).rg * (w0.x  * w12.y);
result += texture(tex, vec2(p12.x, p12.y)).rg * (w12.x * w12.y);
result += texture(tex, vec2(p3.x,  p12.y)).rg * (w3.x  * w12.y);

result += texture(tex, vec2(p0.x,  p3.y )).rg * (w0.x  * w3.y);
result += texture(tex, vec2(p12.x, p3.y )).rg * (w12.x * w3.y);
result += texture(tex, vec2(p3.x,  p3.y )).rg * (w3.x  * w3.y);
return result;
}

void main() {
// Mip level is chosen from the UNdistorted coordinates (must run in uniform control flow).
// Otherwise steep refraction inflates the implicit derivatives, the GPU picks a blurrier mip
// and flips levels between neighbouring 2x2 quads -> blur patches and pixelation.
vec2 dBx = dFdx(backgroundCoord);
vec2 dBy = dFdy(backgroundCoord);

// Pixels outside the image stay transparent (e.g. background-size: contain)
if (backgroundCoord.x < 0.0 || backgroundCoord.x > 1.0 || backgroundCoord.y < 0.0 || backgroundCoord.y > 1.0) {
  fragColor = vec4(0.0);
  return;
}

vec2 coord = backgroundCoord;
float spec = 0.0;
if (hasWaves > 0.5) {
  vec2 grad = sampleCatmullRom(samplerGradient, ripplesCoord);
  vec2 offset = grad / sqrt(dot(grad, grad) + deltaSq);
  // Pixels inside the image never sample "outside": clamp to the edge instead of punching holes
  coord = clamp(backgroundCoord + offset * perturbance, vec2(0.0), vec2(1.0));
  if (specular > 0.0) {
    float d = max(0.0, dot(offset, LIGHT_DIR));
    float d2 = d * d;
    spec = d2 * d2 * specular;
  }
}

vec4 bg = textureGrad(samplerBackground, coord, dBx, dBy);
// bg is premultiplied (see loadImage), so the specular term is scaled by alpha to stay premultiplied
fragColor = vec4(bg.rgb + spec * bg.a, bg.a);
}`;

class Ripples {
  static VERSION = '1.2.0';

  // Soft cap on simultaneously live WebGL contexts (browsers allow ~16 and silently kill the oldest).
  // When exceeded, the least recently used instance that is not animating gives its context back.
  static maxContexts = 8;
  static _active = new Set();
  static _tick = 0;

  static PRESETS = Object.freeze({
    default: Object.freeze({ perturbance: 0.05, dropRadius: 30, damping: 0.975, speed: 1, specular: 0.2 }),
    subtle:  Object.freeze({ perturbance: 0.02, dropRadius: 35, damping: 0.96,  speed: 0.85, specular: false }),
    calm:    Object.freeze({ perturbance: 0.035, dropRadius: 55, damping: 0.985, speed: 0.75, specular: 0.25 }),
    glossy:  Object.freeze({ perturbance: 0.05, dropRadius: 35, damping: 0.98,  speed: 1.15, specular: 0.75 }),
    viscous: Object.freeze({ perturbance: 0.075, dropRadius: 65, damping: 0.945, speed: 0.65, specular: 0.4 })
  });

  static DEFAULTS = {
    imageUrl: null,
    preset: null,
    resolution: 256,
    dropRadius: 30,
    perturbance: 0.05,
    interactive: true,
    lockTouch: false,
    crossOrigin: 'anonymous',
    specular: 0.2,
    damping: 0.975,
    speed: 1,
    autoPause: true,
    dpr: 'auto',
    lazy: true,
    fill: true,
    live: 'auto',
    watchTheme: false,
    releaseOnIdle: true,
    releaseDelay: 4000,
    prewarm: false,
    onReady: null,
    onError: null
  };

  static _resolvePreset(name) {
    if (typeof name === 'string' && Object.hasOwn(Ripples.PRESETS, name)) {
      return Ripples.PRESETS[name];
    }
    console.warn('[Ripples] Unknown preset "' + name + '"');
    return null;
  }

  constructor(element, options = {}) {
    const targetEl = typeof element === 'string' ? document.querySelector(element) : element;
    if (!targetEl) {
      throw new Error('[Ripples] Target element not found: ' + element);
    }

    if (targetEl._ripples) {
      targetEl._ripples.destroy();
    }

    const dataOpts = parseDataOptions(targetEl);
    const hasOptPreset = options.preset !== undefined;
    const presetName = hasOptPreset ? options.preset : dataOpts.preset;
    const preset = presetName ? Ripples._resolvePreset(presetName) : null;
    this.options = hasOptPreset
      ? Object.assign({}, Ripples.DEFAULTS, dataOpts, preset, options)
      : Object.assign({}, Ripples.DEFAULTS, preset, dataOpts, options);
    this.gl = null;
    this.canvas = null;
    this.supported = true;
    this.destroyed = false;

    const tag = targetEl.tagName;
    const isImg = targetEl instanceof HTMLImageElement || tag === 'IMG';
    const isPicture = (typeof HTMLPictureElement !== 'undefined' && targetEl instanceof HTMLPictureElement) || tag === 'PICTURE';
    const isVideo = (typeof HTMLVideoElement !== 'undefined' && targetEl instanceof HTMLVideoElement) || tag === 'VIDEO';
    const isCanvas = (typeof HTMLCanvasElement !== 'undefined' && targetEl instanceof HTMLCanvasElement) || tag === 'CANVAS';

    const pictureImg = isPicture ? targetEl.querySelector('img') : null;
    const parentPicture = (isImg && targetEl.parentNode && targetEl.parentNode.tagName === 'PICTURE')
      ? targetEl.parentNode : null;

    this.targetElement = targetEl;
    this.pictureElement = isPicture ? (pictureImg ? targetEl : null) : parentPicture;
    this.imgElement = isImg ? targetEl : pictureImg;
    this.videoElement = isVideo ? targetEl : null;
    this.canvasElement = isCanvas ? targetEl : null;
    this.mediaElement = this.imgElement || this.videoElement || this.canvasElement || null;
    this._wrappedElement = null;
    this.element = targetEl;

    if (!Ripples.isSupported()) {
      this.destroyed = true;
      this.fail(new Error('WebGL 2 with half-float render targets is not available'));
      return;
    }

    this.step = this.step.bind(this);
    this.updateSize = this.updateSize.bind(this);
    this._clearRect = () => {
      this._rectRaf = null;
      this._rect = null;
    };

    this.interactive = Boolean(this.options.interactive);
    this.lockTouch = Boolean(this.options.lockTouch);
    this.resolution = parseInt(this.options.resolution, 10) || 256;
    this.dropRadius = toPositive(this.options.dropRadius, 30);
    this.crossOrigin = this.options.crossOrigin;
    this._explicitImageUrl = Boolean(this.options.imageUrl);
    this.imageUrl = this.options.imageUrl;
    this.specularIntensity = parseSpecular(this.options.specular);
    this._userPerturbance = toNumber(this.options.perturbance, 0.05);
    this._userDamping = parseDamping(this.options.damping);
    this.speed = parseSpeed(this.options.speed);
    this.speedAccumulator = 0;
    this.autoPause = Boolean(this.options.autoPause);
    this.dpr = this.options.dpr;
    this.fill = this.options.fill !== false;
    this.live = parseLive(this.options.live);

    this.borderLeft = 0;
    this.borderTop = 0;

    // Effective perturbance / damping = user values, softened under prefers-reduced-motion
    this._motionQuery = (typeof window !== 'undefined' && window.matchMedia)
      ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    this.reducedMotion = Boolean(this._motionQuery && this._motionQuery.matches);
    this.applyMotionPreference();

    this.dropData = new Float32Array(MAX_QUEUED_DROPS * 4);
    this.dropCount = 0;
    this.boundariesDirty = true;
    this._rect = null;
    this._rectRaf = null;
    this._resizeRaf = null;
    this._idleTimer = null;
    this._lastUsed = 0;
    this._prewarmHandle = null;
    this._prewarmIsIdle = false;
    this._cssSource = null;
    this._isSvgSource = false;
    this._svgNatural = null;
    this._maxTex = 4096;
    this._texInitialized = false;
    this._ownedVideo = null;
    this._videoListeners = null;
    this._videoReadyEmitted = false;
    this._lastVideoTime = -1;
    this._forceLiveUpload = false;
    this._scaleCanvas = null;
    this._imgLoadHandler = null;
    this._loadToken = 0;
    this._loadingSource = null;
    this._hasSimData = false;
    this._lastHasWaves = null;
    this._path = [];
    this._segLen = [];

    this.visible = true;
    this.running = true;
    this.inViewport = true;
    this.isSleeping = true;
    this.hasActiveRipples = false;
    this.activeTime = 0;
    this.lastStepTime = null;
    this.needsRender = false;
    this.contextLost = false;

    // Wrap direct media element (<img>, <picture>, <video>, <canvas>) or use container.
    // All styling goes through CSSOM (el.style.*), keeping strict style-src CSP compatibility.
    if (this.mediaElement) {
      if (this.imgElement && !this._explicitImageUrl) {
        this.imageUrl = this.imgElement.currentSrc || this.imgElement.src;
      }

      const wrapTarget = this.pictureElement || this.mediaElement;
      const wrapper = document.createElement('div');
      wrapper.className = 'webgl-ripples webgl-ripples-wrapper';

      const comp = window.getComputedStyle(this.mediaElement);
      const wrapComp = wrapTarget !== this.mediaElement ? window.getComputedStyle(wrapTarget) : comp;
      const useWrapBox = wrapTarget !== this.mediaElement &&
        wrapComp.display !== 'inline' && wrapComp.display !== 'contents';
      const boxComp = useWrapBox ? wrapComp : comp;

      wrapper.style.position = 'relative';
      wrapper.style.isolation = 'isolate';
      wrapper.style.display = boxComp.display === 'inline' ? 'inline-block' : boxComp.display;
      wrapper.style.width = this.fill
        ? (wrapTarget.style.width || this.mediaElement.style.width || (boxComp.width !== '0px' ? '100%' : 'auto'))
        : 'fit-content';
      wrapper.style.maxWidth = '100%';
      wrapper.style.lineHeight = '0';
      wrapper.style.verticalAlign = boxComp.verticalAlign || 'middle';
      for (let i = 0; i < MARGIN_SIDES.length; i++) {
        const p = MARGIN_SIDES[i];
        wrapper.style[p] = parseFloat(wrapComp[p]) ? wrapComp[p] : comp[p];
      }

      wrapTarget.parentNode.insertBefore(wrapper, wrapTarget);
      wrapper.appendChild(wrapTarget);
      this._wrappedElement = wrapTarget;

      this.originalMediaOpacity = this.mediaElement.style.opacity;
      this.originalMediaPointerEvents = this.mediaElement.style.pointerEvents;
      this.originalMediaWidth = this.mediaElement.style.width;
      this.originalMediaHeight = this.mediaElement.style.height;
      this.originalMediaMargin = saveMargins(this.mediaElement);
      this.mediaElement.style.margin = '0';
      if (this.pictureElement) {
        this.originalPictureMargin = saveMargins(this.pictureElement);
        this.pictureElement.style.margin = '0';
        this.pictureElement._ripples = this;
      }
      if (this.fill) {
        this.mediaElement.style.width = '100%';
        this.mediaElement.style.height = 'auto';
      }

      this.element = wrapper;
      targetEl._ripples = this;
      this.mediaElement._ripples = this;
    } else {
      this.element.classList.add('webgl-ripples');
      this.originalPosition = this.element.style.position;
      this.originalIsolation = this.element.style.isolation;
      const position = window.getComputedStyle(this.element).position;
      if (!position || position === 'static') {
        this.element.style.position = 'relative';
      }
      // own stacking context, so the z-index:-1 canvas cannot slip behind an ancestor's background
      this.element.style.isolation = 'isolate';
    }

    this.element._ripples = this;

    if (this.imgElement) {
      this._imgLoadHandler = () => {
        if (!this.destroyed && this.gl && !this._explicitImageUrl) {
          this._syncMediaSource();
        }
      };
      this.imgElement.addEventListener('load', this._imgLoadHandler);
    }

    this.canvas = this._createCanvas();
    this.element.appendChild(this.canvas);

    this.originalTouchAction = this.element.style.touchAction;
    this._applyTouchAction();

    this.setupPointerEvents();
    this.setupObservers();

    if (this.options.lazy === false) {
      this.activate();
    }
  }

  _createCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = 0;
    canvas.height = 0;
    const cs = canvas.style;
    cs.position = 'absolute';
    cs.top = '0';
    cs.left = '0';
    cs.width = '100%';
    cs.height = '100%';
    cs.zIndex = this.mediaElement ? '1' : '-1';
    cs.pointerEvents = 'none';
    canvas.setAttribute('aria-hidden', 'true');
    return canvas;
  }

  activate() {
    if (this.gl) return true;
    if (this.destroyed) return false;

    Ripples._makeRoom();

    const glInit = initWebGL2(this.canvas, Ripples._glConfig);
    if (!glInit) {
      this.fail(new Error('WebGL 2 with half-float render targets is not available'));
      return false;
    }

    this.gl = glInit.gl;
    this.glConfig = glInit.config;
    Ripples._glConfig = glInit.config;

    this.handleContextLost = (e) => {
      e.preventDefault();
      this.contextLost = true;
      this._pausedByContextLoss = this.running;
      this.pause();
    };
    this.handleContextRestored = () => {
      this.contextLost = false;
      try {
        this.initGL();
      } catch (err) {
        this.fail(err);
        return;
      }
      // GPU resources are gone: re-upload media and reset loop state
      ++this._loadToken;
      this._loadingSource = null;
      this.imageSource = null;
      this.backgroundWidth = 0;
      this.backgroundHeight = 0;
      this._texInitialized = false;
      this._videoReadyEmitted = false;
      this._lastVideoTime = -1;
      this.boundariesDirty = true;
      this.hasActiveRipples = false;
      this.isSleeping = true;
      this.rafId = null;
      if (this._pausedByContextLoss) {
        this.running = true;
        this._pausedByContextLoss = false;
      }
      this.loadImage();
      this.renderSingleFrame();
    };
    this.canvas.addEventListener('webglcontextlost', this.handleContextLost, false);
    this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored, false);

    try {
      this.initGL();
    } catch (err) {
      this.fail(err);
      return false;
    }

    Ripples._active.add(this);
    this._touch();

    this.updateSize(false);
    this.loadImage();
    return true;
  }

  _touch() {
    this._lastUsed = ++Ripples._tick;
  }

  _clearIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  _scheduleRelease() {
    if (this.options.releaseOnIdle === false) return;
    this._clearIdleTimer();
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (!this.destroyed && !this.hasActiveRipples) this.release();
    }, toNumber(this.options.releaseDelay, 4000));
  }

  static _makeRoom() {
    const max = Ripples.maxContexts;
    if (!(max > 0)) return;
    while (Ripples._active.size >= max) {
      let victim = null;
      for (const r of Ripples._active) {
        if (r.hasActiveRipples) continue; // never interrupt a visible animation
        if (!victim || r._lastUsed < victim._lastUsed) victim = r;
      }
      if (!victim) break;
      victim.release();
    }
  }

  _freeGL() {
    const gl = this.gl;
    if (!gl) return;
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.quad) gl.deleteBuffer(this.quad);
    if (this.backgroundTexture) gl.deleteTexture(this.backgroundTexture);
    if (this.textures) this.textures.forEach(t => gl.deleteTexture(t));
    if (this.framebuffers) this.framebuffers.forEach(fb => gl.deleteFramebuffer(fb));
    if (this.gradTexture) gl.deleteTexture(this.gradTexture);
    if (this.gradFramebuffer) gl.deleteFramebuffer(this.gradFramebuffer);
    if (this.gradientProgram && this.gradientProgram.id) gl.deleteProgram(this.gradientProgram.id);
    if (this.dropProgram && this.dropProgram.id) gl.deleteProgram(this.dropProgram.id);
    if (this.updateProgram && this.updateProgram.id) gl.deleteProgram(this.updateProgram.id);
    if (this.renderProgram && this.renderProgram.id) gl.deleteProgram(this.renderProgram.id);

    const loseCtx = gl.getExtension('WEBGL_lose_context');
    if (loseCtx) loseCtx.loseContext();

    this.gl = null;
    this.vao = this.quad = this.backgroundTexture = this.gradTexture = this.gradFramebuffer = null;
    this.textures = this.framebuffers = null;
    this.gradientProgram = this.dropProgram = this.updateProgram = this.renderProgram = null;
    this._scaleCanvas = null;
  }

  _teardownGL() {
    this._clearIdleTimer();
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this._teardownOwnedVideo();
    if (this.videoElement) {
      this._detachVideoListeners(this.videoElement);
    }
    if (this.canvas && this.handleContextLost) {
      this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
      this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    }
    this._freeGL();
    Ripples._active.delete(this);
  }

  _hideOriginalVisual() {
    if (this.mediaElement) this.mediaElement.style.opacity = '0';
    else this.hideCssBackground();
  }

  _restoreOriginalVisual(reattach = false) {
    if (this.mediaElement) {
      this.mediaElement.style.opacity = this.originalMediaOpacity || '';
      if (reattach && this.imgElement && this.imgElement.parentNode) {
        // Re-attach <img> so Chromium drops any stale SVG/compositor backing after opacity:0 -> ''
        // (Never detach/reattach <video>, as removing a media element from DOM pauses playback.)
        const parent = this.imgElement.parentNode;
        if (parent === this.element || parent === this.pictureElement) {
          const next = this.imgElement.nextSibling;
          this.imgElement.remove();
          parent.insertBefore(this.imgElement, next);
        }
      }
    }
    this.restoreCssBackground();
  }

  /**
   * Frees the WebGL context (and its slot in the browser's context budget) and shows the original
   * image/media again. The next interaction recreates everything. Runs automatically when the ripples have
   * settled (releaseOnIdle) and when more than Ripples.maxContexts instances are live.
   */
  release() {
    if (!this.gl || this.destroyed) return;
    this._teardownGL();

    // A canvas whose context was lost can never get a new one: swap in a fresh element
    const old = this.canvas;
    this.canvas = this._createCanvas();
    if (!this.visible) this.canvas.style.display = 'none';
    old.replaceWith(this.canvas);

    this._restoreOriginalVisual(true);

    ++this._loadToken;
    this._loadingSource = null;
    this._hasSimData = false;
    this._lastHasWaves = null;
    this.hasActiveRipples = false;
    this.isSleeping = true;
    this.needsRender = false;
    this.dropCount = 0;
    this.imageSource = null;
    this.backgroundWidth = 0;
    this.backgroundHeight = 0;
    this._texInitialized = false;
    this._videoReadyEmitted = false;
    this._lastVideoTime = -1;
    this.boundariesDirty = true;
  }

  _syncMediaSource() {
    if (this._explicitImageUrl) return;
    if (this.imgElement) {
      const currentSrc = this.imgElement.currentSrc || this.imgElement.src;
      if (currentSrc && currentSrc !== this.imageSource) {
        this.imageUrl = currentSrc;
        this.loadImage();
      }
    } else if (this.videoElement) {
      const currentSrc = this.videoElement.currentSrc || this.videoElement.src;
      if (currentSrc && currentSrc !== this.imageSource) {
        this.loadImage();
      }
    }
  }

  _readCssBackground() {
    return extractUrl(this.element.style.backgroundImage) ||
      extractUrl(window.getComputedStyle(this.element).backgroundImage);
  }

  _getDpr() {
    return this.dpr === 'auto' ? Math.min(window.devicePixelRatio || 1, 2) : (parseFloat(this.dpr) || 1);
  }

  /**
   * Re-reads the source (<img>/<picture> currentSrc, <video>, <canvas>, or CSS background-image) and redraws.
   * Call it after changing a theme/class or updating a static <canvas>; automatic for themes with watchTheme: true.
   */
  refresh() {
    if (this.destroyed) return;
    this.boundariesDirty = true;

    if (this.imgElement) {
      this._syncMediaSource();
    } else if (this.canvasElement && !this._explicitImageUrl) {
      if (this.gl) {
        this._uploadCanvasSource(this.canvasElement, !this.backgroundWidth);
      }
    } else if (this.videoElement && !this._explicitImageUrl) {
      this._syncMediaSource();
      if (this.gl && this.videoElement.readyState >= 2 && this.videoElement.videoWidth > 0) {
        this._uploadVideoFrame(this.videoElement, !this._videoReadyEmitted);
      }
    } else if (!this.imageUrl && this.gl) {
      // The CSS background is hidden while the effect is live: expose it for one style read
      const wasHidden = this._bgHidden;
      this.restoreCssBackground();
      const url = this._readCssBackground();
      if (wasHidden) this.hideCssBackground();
      if (url) {
        this._cssSource = url;
        this.loadImage();
      }
    }

    this._syncFrame();
  }

  getSvgTargetSize(w, h, maxTex) {
    const dpr = this._getDpr();
    const rect = this.getRect();
    let cssW = rect.width;
    let cssH = rect.height;
    if (!cssW || !cssH) {
      cssW = window.innerWidth || 1024;
      cssH = cssW * h / w;
    }
    const shown = Math.max(cssW, cssH * w / h); // a 'cover' background can be larger than the element
    const cap = Math.min(4096, maxTex || 4096);
    let tw = Math.min(Math.max(Math.round(shown * dpr), 256), cap);
    let th = Math.max(Math.round(tw * h / w), 1);
    if (th > cap) {
      th = cap;
      tw = Math.max(Math.round(th * w / h), 1);
    }
    return { w: tw, h: th };
  }

  rerasterIfNeeded() {
    if (!this.gl || !this._isSvgSource || !this._svgNatural || !this.backgroundWidth) return;
    const t = this.getSvgTargetSize(this._svgNatural.w, this._svgNatural.h, this._maxTex);
    if (t.w > this.backgroundWidth * 1.25) {
      this.imageSource = null;
      this._loadingSource = null;
      this.loadImage();
    }
  }

  fail(err) {
    this.supported = false;
    console.warn('[Ripples] Effect disabled:', err && err.message ? err.message : err);
    this.destroy();
    this._emit('error', err);
  }

  _emit(type, error) {
    const cb = this.options[type === 'ready' ? 'onReady' : 'onError'];
    if (typeof cb === 'function') {
      try {
        if (type === 'ready') cb.call(this, this);
        else cb.call(this, error, this);
      } catch (err) {
        console.error('[Ripples] ' + type + ' callback threw:', err);
      }
    }
    const target = this.targetElement || this.mediaElement || this.element;
    if (target && typeof CustomEvent === 'function') {
      const detail = { instance: this, error: error || null };
      // async, so listeners attached right after construction still receive it
      Promise.resolve().then(() => {
        target.dispatchEvent(new CustomEvent('ripples:' + type, { bubbles: true, detail }));
      });
    }
  }

  // Element rect, read at most once per frame instead of on every pointer event
  getRect() {
    if (!this._rect) {
      this._rect = this.element.getBoundingClientRect();
      if (!this._rectRaf) {
        this._rectRaf = requestAnimationFrame(this._clearRect);
      }
    }
    return this._rect;
  }

  applyMotionPreference() {
    const reduced = this.reducedMotion;
    this.perturbance = reduced ? this._userPerturbance * 0.4 : this._userPerturbance;
    this.damping = reduced ? Math.min(this._userDamping, 0.92) : this._userDamping;
    if (this.gl && this.renderProgram && this.updateProgram) {
      this.gl.useProgram(this.renderProgram.id);
      this.gl.uniform1f(this.renderProgram.locations.perturbance, this.perturbance);
      this.gl.useProgram(this.updateProgram.id);
      this.gl.uniform1f(this.updateProgram.locations.damping, this.damping);
    }
  }

  initGL() {
    const gl = this.gl;
    const config = this.glConfig;

    // Extensions must be (re-)enabled after a context restore
    enableFloatExtensions(gl);
    this._maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,
      +1, -1,
      +1, +1,
      -1, +1
    ]), gl.STATIC_DRAW);

    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Ping-pong render targets (NEAREST: simulation only reads exact texel centres)
    this.textures = [];
    this.framebuffers = [];
    this.bufferWriteIndex = 0;
    this.bufferReadIndex = 1;
    this._hasSimData = false;

    for (let i = 0; i < 2; i++) {
      const rt = createRenderTarget(gl, this.resolution, config, gl.NEAREST);
      this.textures.push(rt.texture);
      this.framebuffers.push(rt.framebuffer);
    }

    // Gradient target (LINEAR: relied on by the bicubic sampler in the render shader)
    const grad = createRenderTarget(gl, this.resolution, config, gl.LINEAR);
    this.gradTexture = grad.texture;
    this.gradFramebuffer = grad.framebuffer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.dropProgram = createProgram(gl, QUAD_VS, DROP_FS);
    this.updateProgram = createProgram(gl, QUAD_VS, UPDATE_FS);
    this.gradientProgram = createProgram(gl, QUAD_VS, GRADIENT_FS);
    this.renderProgram = createProgram(gl, RENDER_VS, RENDER_FS);

    gl.useProgram(this.dropProgram.id);
    gl.uniform1i(this.dropProgram.locations.uTexture, 0);

    gl.useProgram(this.updateProgram.id);
    gl.uniform1i(this.updateProgram.locations.uTexture, 0);
    gl.uniform1f(this.updateProgram.locations.damping, this.damping);
    gl.uniform1f(this.updateProgram.locations.fade, 1.0);

    gl.useProgram(this.gradientProgram.id);
    gl.uniform1i(this.gradientProgram.locations.uTexture, 0);

    const texel = 1 / this.resolution;
    gl.useProgram(this.renderProgram.id);
    gl.uniform1i(this.renderProgram.locations.samplerBackground, 0);
    gl.uniform1i(this.renderProgram.locations.samplerGradient, 1);
    gl.uniform1f(this.renderProgram.locations.deltaSq, 4 * texel * texel);
    gl.uniform1f(this.renderProgram.locations.perturbance, this.perturbance);
    gl.uniform1f(this.renderProgram.locations.specular, this.specularIntensity);
    gl.uniform1f(this.renderProgram.locations.hasWaves, 0.0);
    this._lastHasWaves = false;

    this.backgroundTexture = gl.createTexture();
    this._texInitialized = false;
    this.setTransparentTexture();
    configureTexture(gl, gl.LINEAR);
  }

  bindTexture(texture, unit = 0) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
  }

  setTransparentTexture() {
    if (!this.gl || !this.backgroundTexture) return;
    const gl = this.gl;
    this.bindTexture(this.backgroundTexture, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, BLANK_PIXEL);
    this._texInitialized = false;
  }

  hideCssBackground() {
    if (this.mediaElement) return;
    const inlineCss = this.element.style.backgroundImage;
    if (inlineCss === 'none') return;
    this.originalInlineCss = inlineCss;
    this.element.style.backgroundImage = 'none';
    this._bgHidden = true;
  }

  restoreCssBackground() {
    if (this.mediaElement || !this._bgHidden) return;
    this.element.style.backgroundImage = this.originalInlineCss || '';
    this._bgHidden = false;
  }

  _getLiveSource() {
    if (this.videoElement && !this._explicitImageUrl) return this.videoElement;
    if (this._ownedVideo) return this._ownedVideo;
    if (this.canvasElement && !this._explicitImageUrl) return this.canvasElement;
    return null;
  }

  _isLiveMedia() {
    if (this.live === false) return false;
    const src = this._getLiveSource();
    if (!src) return false;
    if (src === this.canvasElement) return true;
    return !src.paused && !src.ended && src.readyState >= 2;
  }

  _detachVideoListeners(video) {
    if (!this._videoListeners || (video && this._videoListeners.video !== video)) return;
    const { video: v, onLoadedData, onPlay, onSeeked, onPause, onError, lastSource, onSourceError } = this._videoListeners;
    v.removeEventListener('loadeddata', onLoadedData);
    v.removeEventListener('play', onPlay);
    v.removeEventListener('playing', onPlay);
    v.removeEventListener('seeked', onSeeked);
    v.removeEventListener('pause', onPause);
    v.removeEventListener('ended', onPause);
    v.removeEventListener('error', onError);
    if (lastSource && onSourceError) {
      lastSource.removeEventListener('error', onSourceError);
    }
    this._videoListeners = null;
  }

  _attachVideoListeners(video) {
    this._detachVideoListeners();
    const isCurrent = () => !this.destroyed && this.gl && video === this._getLiveSource();

    const onLoadedData = () => {
      if (!isCurrent()) return;
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        this._uploadVideoFrame(video, !this._videoReadyEmitted);
      }
    };
    const onPlay = () => {
      if (!isCurrent()) return;
      this._forceLiveUpload = true;
      if (this.running && this._isLiveMedia()) this._startLoop();
    };
    const onSeeked = () => {
      if (!isCurrent() || video.readyState < 2) return;
      this._uploadVideoFrame(video, !this._videoReadyEmitted);
      if (this.isSleeping || !this.rafId) this.renderSingleFrame();
    };
    const onPause = () => {
      if (!isCurrent()) return;
      if (video.readyState >= 2 && video.videoWidth > 0) {
        this._uploadVideoFrame(video, !this._videoReadyEmitted);
      }
      if (!this.hasActiveRipples) this.renderSingleFrame();
    };
    const onError = () => {
      if (!isCurrent()) return;
      this.setTransparentTexture();
      this._restoreOriginalVisual();
      this._emit('error', new Error('Failed to load video: ' + (video.currentSrc || video.src || this.imageSource || '')));
    };

    video.addEventListener('loadeddata', onLoadedData);
    video.addEventListener('play', onPlay);
    video.addEventListener('playing', onPlay);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onPause);
    video.addEventListener('error', onError);

    let lastSource = null;
    let onSourceError = null;
    if (!video.src && video.querySelectorAll) {
      const sources = video.querySelectorAll('source');
      if (sources.length) {
        lastSource = sources[sources.length - 1];
        onSourceError = onError;
        lastSource.addEventListener('error', onSourceError);
      }
    }

    this._videoListeners = { video, onLoadedData, onPlay, onSeeked, onPause, onError, lastSource, onSourceError };
  }

  _teardownOwnedVideo() {
    if (!this._ownedVideo) return;
    this._detachVideoListeners(this._ownedVideo);
    try {
      this._ownedVideo.pause();
      this._ownedVideo.removeAttribute('src');
      this._ownedVideo.load();
    } catch (e) { /* ignore in mocked environments */ }
    this._ownedVideo = null;
  }

  _uploadBackgroundTexture(source, width, height, { live = false, isSvg = false, naturalW = width, naturalH = height, emitReady = false } = {}) {
    const gl = this.gl;
    if (!gl || !this.backgroundTexture) return false;

    const maxTex = this._maxTex;
    let sourceToUpload = source;

    if (!this.mediaElement && (this.isAutoAspectRatio || this.element.clientHeight === 0)) {
      if (!this.isAutoAspectRatio) {
        this.originalAutoDisplay = this.element.style.display;
        this.originalAutoWidth = this.element.style.width;
        this.originalAutoAspectRatio = this.element.style.aspectRatio;
        this.isAutoAspectRatio = true;
      }
      const nextRatio = `${width} / ${height}`;
      if (this.element.style.aspectRatio !== nextRatio) {
        this.element.style.display = 'block';
        this.element.style.width = '100%';
        this.element.style.aspectRatio = nextRatio;
        if (!emitReady) this.updateSize();
      }
    }

    let tw, th;
    if (isSvg) {
      ({ w: tw, h: th } = this.getSvgTargetSize(width, height, maxTex));
    } else if (width > maxTex || height > maxTex) {
      const k = maxTex / Math.max(width, height);
      tw = Math.max(Math.floor(width * k), 1);
      th = Math.max(Math.floor(height * k), 1);
    }
    if (tw) {
      const c = live ? (this._scaleCanvas || (this._scaleCanvas = document.createElement('canvas'))) : document.createElement('canvas');
      if (c.width !== tw) c.width = tw;
      if (c.height !== th) c.height = th;
      const ctx = c.getContext('2d');
      if (!isSvg) ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, tw, th);
      ctx.drawImage(source, 0, 0, tw, th);
      sourceToUpload = c;
      width = tw;
      height = th;
    }

    const canSubImage = live && this._texInitialized && this.backgroundWidth === width && this.backgroundHeight === height;

    this.bindTexture(this.backgroundTexture, 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);

    try {
      if (canSubImage) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, sourceToUpload);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceToUpload);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
        if (live) {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        } else {
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        this._texInitialized = true;
      }
    } catch (err) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
      this.backgroundWidth = 0;
      this.backgroundHeight = 0;
      this.setTransparentTexture();
      this._restoreOriginalVisual();
      this._emit('error', err);
      return false;
    }

    if (this.backgroundWidth !== width || this.backgroundHeight !== height) {
      this.boundariesDirty = true;
    }
    this.backgroundWidth = width;
    this.backgroundHeight = height;
    this._isSvgSource = isSvg;
    this._svgNatural = isSvg ? { w: naturalW, h: naturalH } : null;

    if (emitReady) {
      if (this.mediaElement) this.mediaElement.style.pointerEvents = 'none';
      if (this.visible) this._hideOriginalVisual();

      this.boundariesDirty = true;
      this.updateSize();
      this.renderSingleFrame();
      this._emit('ready');
      if (this._isLiveMedia() && this.running) {
        this._startLoop();
      }
    }

    return true;
  }

  _uploadCanvasSource(canvas, emitReady = false) {
    const w = canvas.width || 0;
    const h = canvas.height || 0;
    if (!w || !h) {
      this.setTransparentTexture();
      this._emit('error', new Error('Canvas has zero dimensions'));
      return false;
    }
    return this._uploadBackgroundTexture(canvas, w, h, {
      live: this.live !== false,
      emitReady
    });
  }

  _uploadVideoFrame(video, emitReady = false) {
    const w = video.videoWidth || 0;
    const h = video.videoHeight || 0;
    if (!w || !h || video.readyState < 2) return false;
    if (video === this.videoElement && !this._explicitImageUrl) {
      this.imageSource = video.currentSrc || video.src || this.imageSource || '__video__';
    }
    this._lastVideoTime = video.currentTime;
    this._forceLiveUpload = false;
    const ok = this._uploadBackgroundTexture(video, w, h, { live: true, emitReady });
    if (ok && emitReady) {
      this._videoReadyEmitted = true;
    }
    return ok;
  }

  _uploadLiveFrame() {
    if (!this.gl || !this.backgroundTexture) return false;
    const src = this._getLiveSource();
    if (!src) return false;
    if (src === this.canvasElement) {
      if (!src.width || !src.height) return false;
      this._forceLiveUpload = false;
      return this._uploadBackgroundTexture(src, src.width, src.height, { live: true });
    }
    if (src.readyState < 2 || !src.videoWidth || !src.videoHeight) return false;
    const t = src.currentTime;
    if (!this._forceLiveUpload && t === this._lastVideoTime) return false;
    return this._uploadVideoFrame(src, !this._videoReadyEmitted);
  }

  loadImage() {
    if (!this.gl) return;

    if (this.canvasElement && !this._explicitImageUrl) {
      ++this._loadToken;
      this._loadingSource = null;
      this._teardownOwnedVideo();
      this.imageSource = '__canvas__';
      this._uploadCanvasSource(this.canvasElement, true);
      return;
    }

    if (this.videoElement && !this._explicitImageUrl) {
      this._teardownOwnedVideo();
      const video = this.videoElement;
      const src = video.currentSrc || video.src || '__video__';
      if (src === this.imageSource && (this.backgroundWidth || (this._videoListeners && this._videoListeners.video === video))) return;
      ++this._loadToken;
      this._loadingSource = null;
      this.imageSource = src;
      this._videoReadyEmitted = false;
      this._lastVideoTime = -1;
      if (isRemoteUrl(src) && this.crossOrigin && !video.crossOrigin && video.readyState === 0) {
        video.crossOrigin = this.crossOrigin;
      }
      this._attachVideoListeners(video);
      if (video.error) {
        this.setTransparentTexture();
        this._emit('error', new Error('Failed to load video: ' + src));
        return;
      }
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        this._uploadVideoFrame(video, true);
      }
      return;
    }

    if (this.imgElement && !this._explicitImageUrl && !this.imageUrl) {
      this.imageUrl = this.imgElement.currentSrc || this.imgElement.src;
    }

    let newSource = this.imageUrl;
    if (!newSource) {
      if (this._bgHidden && this._cssSource) {
        newSource = this._cssSource; // we hid the CSS background ourselves: do not read it again
      } else {
        newSource = this._readCssBackground();
        this._cssSource = newSource;
      }
    }

    if (newSource === this.imageSource && (this.backgroundWidth || this._loadingSource === newSource)) return;

    const token = ++this._loadToken;
    this._loadingSource = null;
    this._teardownOwnedVideo();
    this.imageSource = newSource;
    if (!this.imageSource) {
      this.setTransparentTexture();
      return;
    }

    if (isVideoUrl(this.imageSource)) {
      const video = document.createElement('video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.autoplay = true;
      video.preload = 'auto';
      if (isRemoteUrl(this.imageSource) && this.crossOrigin) {
        video.crossOrigin = this.crossOrigin;
      }
      this._ownedVideo = video;
      this._videoReadyEmitted = false;
      this._lastVideoTime = -1;
      this._attachVideoListeners(video);
      video.src = this.imageSource;
      try {
        const p = video.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (e) { /* autoplay or mocked play */ }
      return;
    }

    const isSvg = /\.svg($|\?)/i.test(this.imageSource) || /^data:image\/svg\+xml/i.test(this.imageSource);
    this._loadingSource = newSource;

    const image = new Image();
    image.onload = () => {
      if (this.destroyed || !this.gl || this._loadToken !== token) return; // stale load
      this._loadingSource = null;
      let width = image.naturalWidth || image.width || 0;
      let height = image.naturalHeight || image.height || 0;

      if (!width || !height) {
        // SVG without width/height attributes has no intrinsic size: use the element's, else the 300x150 default
        const rect = this.getRect();
        const known = rect.width > 0 && rect.height > 0;
        width = known ? rect.width : 300;
        height = known ? rect.height : 150;
      }

      this._uploadBackgroundTexture(image, width, height, {
        live: false,
        isSvg,
        naturalW: width,
        naturalH: height,
        emitReady: true
      });
    };

    image.onerror = () => {
      if (this.destroyed || !this.gl || this._loadToken !== token) return;
      this._loadingSource = null;
      this.setTransparentTexture();
      this._emit('error', new Error('Failed to load image: ' + this.imageSource));
    };

    if (isRemoteUrl(this.imageSource) && this.crossOrigin) {
      image.crossOrigin = this.crossOrigin;
    }

    image.src = this.imageSource;
  }

  getEffectiveRadius(baseRadius, longestSide) {
    const radius = baseRadius !== undefined ? baseRadius : this.dropRadius;
    const side = longestSide || Math.max(
      this.lastClientWidth || this.element.clientWidth || 0,
      this.lastClientHeight || this.element.clientHeight || 0
    ) || 1200;
    const scale = Math.min(Math.max(side / 1200, 0.5), 1.3);
    return radius * scale;
  }

  clearRipples() {
    if (!this.gl || !this.framebuffers) return;
    const gl = this.gl;
    this.dropCount = 0;
    this._hasSimData = false;
    for (let i = 0; i < 2; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers[i]);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _applyTouchAction() {
    if (!this.element) return;
    this.element.style.touchAction = this.lockTouch && this.interactive
      ? 'none'
      : (this.originalTouchAction || '');
  }

  setupPointerEvents() {
    let lastX = null;
    let lastY = null;

    const onPointerEnter = () => {
      if (this.visible && this.running && this.interactive) this.activate();
    };

    const onPointerMove = (e) => {
      if (!this.visible || !this.running || !this.interactive) return;

      const isTouch = e.pointerType === 'touch';
      const hasLast = lastX !== null;
      if (hasLast) {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        const minDistSq = !this.lockTouch && isTouch ? 256 : 16;
        if (dx * dx + dy * dy < minDistSq) return;
      }
      if (!this.gl && !this.activate()) return;

      // Path travelled since the previous accepted sample. Browser-coalesced samples
      // (several per frame on high-rate mice) only refine its curvature. The array is reused.
      const path = this._path;
      path.length = 0;
      if (hasLast) path.push(lastX, lastY);
      const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
      if (coalesced && coalesced.length > 1) {
        for (let i = 0; i < coalesced.length; i++) {
          path.push(coalesced[i].clientX, coalesced[i].clientY);
        }
      }
      path.push(e.clientX, e.clientY);

      lastX = e.clientX;
      lastY = e.clientY;

      const rect = this.getRect();
      const effRadius = this.getEffectiveRadius(this.dropRadius, Math.max(rect.width, rect.height));
      const effStrength = isTouch ? 0.008 : 0.01;
      this.emitTrail(path, effRadius, effStrength, rect);
    };

    const onPointerDown = (e) => {
      if (!this.visible || !this.running || !this.interactive) return;
      if (!this.gl && !this.activate()) return;
      lastX = e.clientX;
      lastY = e.clientY;

      const rect = this.getRect();
      const isTouch = e.pointerType === 'touch';
      const effRadius = this.getEffectiveRadius(this.dropRadius, Math.max(rect.width, rect.height)) * (isTouch ? 1.25 : 1.5);
      const effStrength = isTouch ? 0.09 : 0.14;
      this.queueDrop(
        e.clientX - rect.left - this.borderLeft,
        e.clientY - rect.top - this.borderTop,
        effRadius,
        effStrength,
        rect
      );
      this.wakeUp();
    };

    const onPointerLeave = () => {
      lastX = null;
      lastY = null;
    };

    this._pointerEnterHandler = onPointerEnter;
    this._pointerMoveHandler = onPointerMove;
    this._pointerDownHandler = onPointerDown;
    this._pointerLeaveHandler = onPointerLeave;

    this.element.addEventListener('pointerenter', onPointerEnter, { passive: true });
    this.element.addEventListener('pointermove', onPointerMove, { passive: true });
    this.element.addEventListener('pointerdown', onPointerDown, { passive: true });
    this.element.addEventListener('pointerleave', onPointerLeave, { passive: true });
    this.element.addEventListener('pointercancel', onPointerLeave, { passive: true });
  }

  /**
   * Places drops along a polyline path (flat [x0, y0, x1, y1, ...] in client px) so that fast
   * strokes leave a continuous wake instead of isolated "pearls".
   * A short move (<= half a drop radius) is still one drop of full strength, exactly as before.
   * For longer moves the energy of the old single drop is spread over the path:
   * per-drop strength = strength * spacing / min(pathLength, radius).
   */
  emitTrail(path, radius, strength, rect) {
    const segs = path.length / 2 - 1;
    const offX = rect.left + this.borderLeft;
    const offY = rect.top + this.borderTop;

    let total = 0;
    const segLen = this._segLen;
    segLen.length = Math.max(segs, 0);
    for (let i = 0; i < segs; i++) {
      segLen[i] = Math.hypot(path[2 * i + 2] - path[2 * i], path[2 * i + 3] - path[2 * i + 1]);
      total += segLen[i];
    }

    const endX = path[path.length - 2];
    const endY = path[path.length - 1];
    const n = segs > 0
      ? Math.min(Math.max(Math.ceil(total / (TRAIL_SPACING * radius)), 1), MAX_TRAIL_DROPS)
      : 1;

    if (n === 1 || total <= 0) {
      this.queueDrop(endX - offX, endY - offY, radius, strength, rect);
      this.wakeUp();
      return;
    }

    const gap = total / n;
    const perDrop = strength * gap / Math.min(total, radius);
    let seg = 0;
    let segStart = 0;
    for (let i = 1; i <= n; i++) {
      const t = gap * i;
      while (seg < segs - 1 && segStart + segLen[seg] < t) {
        segStart += segLen[seg];
        seg++;
      }
      const f = segLen[seg] > 0 ? Math.min(Math.max((t - segStart) / segLen[seg], 0), 1) : 1;
      const x = path[2 * seg] + (path[2 * seg + 2] - path[2 * seg]) * f;
      const y = path[2 * seg + 1] + (path[2 * seg + 3] - path[2 * seg + 1]) * f;
      this.queueDrop(x - offX, y - offY, radius, perDrop, rect);
    }
    this.wakeUp();
  }

  setupObservers() {
    if ('IntersectionObserver' in window) {
      this.intersectionObserver = new IntersectionObserver((entries) => {
        for (let i = 0; i < entries.length; i++) {
          this.inViewport = entries[i].isIntersecting;
          if (this.inViewport) {
            this.boundariesDirty = true;
            this._syncFrame();
            if (this.options.prewarm && !this.gl && !this._prewarmHandle) {
              const run = () => {
                this._prewarmHandle = null;
                if (!this.destroyed && this.inViewport && !this.gl) this.activate();
              };
              if (window.requestIdleCallback) {
                this._prewarmIsIdle = true;
                this._prewarmHandle = window.requestIdleCallback(run);
              } else {
                this._prewarmIsIdle = false;
                this._prewarmHandle = setTimeout(run, 200);
              }
            }
          }
        }
      }, { threshold: 0.01 });
      this.intersectionObserver.observe(this.element);
    }

    if ('ResizeObserver' in window) {
      let lastContentW = -1;
      let lastContentH = -1;
      const onResize = () => {
        if (this._resizeRaf) return;
        this._resizeRaf = requestAnimationFrame(() => {
          this._resizeRaf = null;
          this.boundariesDirty = true;
          this.updateSize();
        });
      };
      this.resizeObserver = new ResizeObserver((entries) => {
        if (!this.gl) {
          lastContentW = -1;
          lastContentH = -1;
          return;
        }
        for (let i = 0; i < entries.length; i++) {
          const cr = entries[i].contentRect;
          if (!cr) continue;
          const w = Math.round(cr.width);
          const h = Math.round(cr.height);
          if (w !== lastContentW || h !== lastContentH) {
            lastContentW = w;
            lastContentH = h;
            onResize();
            break;
          }
        }
      });
      this.resizeObserver.observe(this.element);
    }

    this.handleVisibility = () => {
      if (!document.hidden && this.inViewport) {
        this.boundariesDirty = true;
        this._syncFrame();
      }
    };
    document.addEventListener('visibilitychange', this.handleVisibility);

    if (this._motionQuery) {
      this._onMotionChange = (e) => {
        this.reducedMotion = e.matches;
        this.applyMotionPreference();
        this._syncFrame();
      };
      this._motionQuery.addEventListener('change', this._onMotionChange);
    }

    if (this.options.watchTheme) {
      if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && document.documentElement) {
        this.themeObserver = new MutationObserver(() => this.refresh());
        this.themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-theme', 'class']
        });
      }
      if (window.matchMedia) {
        this._schemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
        this._onSchemeChange = () => this.refresh();
        this._schemeQuery.addEventListener('change', this._onSchemeChange);
      }
    }
  }

  computeTextureBoundaries() {
    if (!this.backgroundWidth || !this.backgroundHeight || !this.gl) return;

    const maxSide = Math.max(this.canvas.width, this.canvas.height) || 1;
    const crX = this.canvas.width / maxSide;
    const crY = this.canvas.height / maxSide;

    let tlX = 0;
    let tlY = 0;
    let brX = 1;
    let brY = 1;

    if (!this.mediaElement && !this.isAutoAspectRatio) {
      const rect = this.getRect();
      const style = window.getComputedStyle(this.element);
      const bgSize = (style.backgroundSize || 'cover').split(',')[0].trim();

      let bgW = this.backgroundWidth;
      let bgH = this.backgroundHeight;

      if (bgSize === 'cover' || bgSize === 'contain') {
        const scale = bgSize === 'cover'
          ? Math.max(rect.width / bgW, rect.height / bgH)
          : Math.min(rect.width / bgW, rect.height / bgH);
        bgW *= scale;
        bgH *= scale;
      }

      const bgX = (rect.width - bgW) * 0.5;
      const bgY = (rect.height - bgH) * 0.5;

      tlX = bgW !== 0 ? -bgX / bgW : 0;
      tlY = bgH !== 0 ? -bgY / bgH : 0;
      brX = tlX + (bgW !== 0 ? rect.width / bgW : 1);
      brY = tlY + (bgH !== 0 ? rect.height / bgH : 1);
    }

    const gl = this.gl;
    gl.useProgram(this.renderProgram.id);
    gl.uniform2f(this.renderProgram.locations.topLeft, tlX, tlY);
    gl.uniform2f(this.renderProgram.locations.bottomRight, brX, brY);
    gl.uniform2f(this.renderProgram.locations.containerRatio, crX, crY);
  }

  drawQuad() {
    this.gl.drawArrays(this.gl.TRIANGLE_FAN, 0, 4);
  }

  updateGradient() {
    const gl = this.gl;
    gl.viewport(0, 0, this.resolution, this.resolution);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gradFramebuffer);
    this.bindTexture(this.textures[this.bufferReadIndex], 0);
    gl.useProgram(this.gradientProgram.id);
    this.drawQuad();
  }

  render() {
    const gl = this.gl;
    const needGrad = this._hasSimData && (this.perturbance !== 0 || this.specularIntensity > 0);
    if (needGrad) {
      this.updateGradient();
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    gl.useProgram(this.renderProgram.id);
    if (this._lastHasWaves !== needGrad) {
      gl.uniform1f(this.renderProgram.locations.hasWaves, needGrad ? 1.0 : 0.0);
      this._lastHasWaves = needGrad;
    }
    this.bindTexture(this.backgroundTexture, 0);
    if (needGrad) this.bindTexture(this.gradTexture, 1);
    this.drawQuad();
  }

  _syncFrame() {
    if (this.hasActiveRipples) this.wakeUp();
    else if (this._isLiveMedia() && this.running) this._startLoop();
    else this.renderSingleFrame();
  }

  renderSingleFrame() {
    if (this.destroyed || this.contextLost || !this.gl || !this.canvas) return;
    if (this.boundariesDirty) {
      this.computeTextureBoundaries();
      this.boundariesDirty = false;
    }
    this.render();
  }

  swapBufferIndices() {
    this.bufferWriteIndex = 1 - this.bufferWriteIndex;
    this.bufferReadIndex = 1 - this.bufferReadIndex;
  }

  step(timestamp) {
    if (this.destroyed || this.contextLost) return;

    if (!this.visible || !this.inViewport || document.hidden) {
      this.isSleeping = true;
      this.rafId = null;
      return;
    }

    if (this.boundariesDirty) {
      this.computeTextureBoundaries();
      this.boundariesDirty = false;
    }

    this.flushDrops();

    // Paused: present any pending change once, then sleep instead of spinning requestAnimationFrame.
    // play() / drop() / observers wake the loop again.
    if (!this.running) {
      if (this.needsRender) {
        this.render();
        this.needsRender = false;
      }
      this.isSleeping = true;
      this.rafId = null;
      this.lastStepTime = null;
      return;
    }

    // Frame time (ms), clamped. First frame after wake-up counts as exactly one step.
    const now = timestamp ?? performance.now();
    let dt = this.lastStepTime === null ? STEP_MS : now - this.lastStepTime;
    this.lastStepTime = now;
    dt = Math.min(Math.max(dt, 0), MAX_FRAME_MS);

    const live = this._isLiveMedia();
    let settled = false;

    if (this.hasActiveRipples && this.autoPause) {
      this.activeTime += dt;
      settled = this.activeTime >= SETTLE_END_MS;
    }

    let steps = 0;
    if (this.hasActiveRipples && !settled) {
      this.speedAccumulator += dt * this.speed / STEP_MS;
      steps = Math.min(Math.floor(this.speedAccumulator + STEP_TOLERANCE), MAX_STEPS_PER_FRAME);
      this.speedAccumulator = Math.min(this.speedAccumulator - steps, 1);
      if (steps > 0) {
        const gl = this.gl;
        gl.viewport(0, 0, this.resolution, this.resolution);
        gl.useProgram(this.updateProgram.id);
        gl.activeTexture(gl.TEXTURE0);
        if (this.autoPause && this.activeTime > SETTLE_DECAY_START_MS) {
          const decayProgress = Math.min(
            (this.activeTime - SETTLE_DECAY_START_MS) / (SETTLE_END_MS - SETTLE_DECAY_START_MS), 1.0
          );
          gl.uniform1f(this.updateProgram.locations.damping, this.damping * (1.0 - decayProgress * 0.4));
          // Damping only kills velocity, which would freeze a leftover static bump that then
          // "pops" away on clear. Relaxing the height as well lets it fade out invisibly.
          gl.uniform1f(this.updateProgram.locations.fade, 1.0 - SETTLE_FADE * decayProgress);
        }
        for (let i = 0; i < steps; i++) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers[this.bufferWriteIndex]);
          gl.bindTexture(gl.TEXTURE_2D, this.textures[this.bufferReadIndex]);
          this.drawQuad();
          this.swapBufferIndices();
        }
      }
    }

    const liveUploaded = live ? this._uploadLiveFrame() : false;

    if (settled) {
      const gl = this.gl;
      gl.useProgram(this.updateProgram.id);
      gl.uniform1f(this.updateProgram.locations.damping, this.damping);
      gl.uniform1f(this.updateProgram.locations.fade, 1.0);

      this.clearRipples();
      this.render();
      this.needsRender = false;
      this.hasActiveRipples = false;
      this._scheduleRelease();
      if (!live) {
        this.isSleeping = true;
        this.rafId = null;
        return;
      }
    } else {
      // Nothing changed since the last presented frame (e.g. 144 Hz display) -> skip the GPU work
      if (steps > 0 || this.needsRender || liveUploaded) {
        this.render();
        this.needsRender = false;
      }
      if (!this.hasActiveRipples && !live) {
        this.isSleeping = true;
        this.rafId = null;
        return;
      }
    }

    this.rafId = requestAnimationFrame(this.step);
  }

  _startLoop() {
    if (this.isSleeping || !this.rafId) {
      this.isSleeping = false;
      this.lastStepTime = null;
      this.speedAccumulator = 0;
      if (!this.destroyed && this.running && this.visible && this.inViewport && !document.hidden) {
        this.rafId = requestAnimationFrame(this.step);
      }
    }
  }

  wakeUp() {
    this._clearIdleTimer();
    this._touch();
    this.activeTime = 0;
    this.needsRender = true;
    this.hasActiveRipples = true;
    if (this.gl && this.updateProgram) {
      this.gl.useProgram(this.updateProgram.id);
      this.gl.uniform1f(this.updateProgram.locations.damping, this.damping);
      this.gl.uniform1f(this.updateProgram.locations.fade, 1.0);
    }
    this._startLoop();
  }

  drop(x, y, radius, strength) {
    if (this.destroyed || this.contextLost) return;
    if (!this.gl && !this.activate()) return;
    this.queueDrop(x, y, radius, strength);
    this.wakeUp();
  }

  queueDrop(x, y, radius, strength, cachedRect) {
    if (!this.gl || this.destroyed || this.contextLost) return;

    const rect = cachedRect || this.getRect();
    const elWidth = rect.width || this.canvas.width;
    const elHeight = rect.height || this.canvas.height;
    const rawSide = Math.max(elWidth, elHeight);
    const longestSide = rawSide || 1;

    const effectiveRadius = radius !== undefined ? radius : this.getEffectiveRadius(this.dropRadius, rawSide);
    const s = strength !== undefined ? strength : 0.01;

    if (this.dropCount >= MAX_QUEUED_DROPS) {
      // Queue full (very long stall): discard the oldest drop
      this.dropData.copyWithin(0, 4, this.dropCount * 4);
      this.dropCount--;
    }

    const o = this.dropCount * 4;
    this.dropData[o] = (x - elWidth * 0.5) / longestSide + 0.5;
    this.dropData[o + 1] = (elHeight * 0.5 - y) / longestSide + 0.5;
    this.dropData[o + 2] = effectiveRadius / longestSide;
    this.dropData[o + 3] = s;
    this.dropCount++;
  }

  flushDrops() {
    const total = this.dropCount;
    if (!total || !this.gl || !this.dropProgram) return;
    const gl = this.gl;
    const locs = this.dropProgram.locations;
    const arrayLoc = locs['drops[0]'] || locs.drops;

    gl.viewport(0, 0, this.resolution, this.resolution);
    gl.useProgram(this.dropProgram.id);

    for (let offset = 0; offset < total; offset += MAX_DROPS_PER_PASS) {
      const batch = Math.min(total - offset, MAX_DROPS_PER_PASS);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers[this.bufferWriteIndex]);
      this.bindTexture(this.textures[this.bufferReadIndex], 0);
      gl.uniform4fv(arrayLoc, this.dropData.subarray(offset * 4, (offset + batch) * 4));
      gl.uniform1i(locs.dropCount, batch);
      this.drawQuad();
      this.swapBufferIndices();
    }

    this.dropCount = 0;
    this._hasSimData = true;
    this.needsRender = true;
  }

  updateSize(syncMedia = true) {
    if (this.destroyed || !this.canvas) return;
    this._rect = null;
    if (!this.gl) return;

    const rect = this.getRect();
    const style = window.getComputedStyle(this.element);
    this.borderLeft = parseFloat(style.borderLeftWidth) || 0;
    this.borderTop = parseFloat(style.borderTopWidth) || 0;

    if (syncMedia) this._syncMediaSource();

    const dpr = this._getDpr();
    const newWidth = Math.round(rect.width * dpr);
    const newHeight = Math.round(rect.height * dpr);

    if (newWidth > 0 && newHeight > 0 && (newWidth !== this.canvas.width || newHeight !== this.canvas.height)) {
      const oldAspect = this.canvas.width && this.canvas.height ? (this.canvas.width / this.canvas.height) : 0;
      const newAspect = newWidth / newHeight;
      if (oldAspect && Math.abs(oldAspect - newAspect) / oldAspect > 0.12) {
        this.clearRipples();
      }

      this.canvas.width = newWidth;
      this.canvas.height = newHeight;
      this.lastClientWidth = Math.round(rect.width);
      this.lastClientHeight = Math.round(rect.height);
      this.boundariesDirty = true;
      this.rerasterIfNeeded();

      this._syncFrame();
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;

    this.running = false;
    this.hasActiveRipples = false;
    ++this._loadToken;
    this._loadingSource = null;

    if (this._prewarmHandle) {
      if (this._prewarmIsIdle && window.cancelIdleCallback) window.cancelIdleCallback(this._prewarmHandle);
      else clearTimeout(this._prewarmHandle);
      this._prewarmHandle = null;
    }
    if (this._resizeRaf) {
      cancelAnimationFrame(this._resizeRaf);
      this._resizeRaf = null;
    }
    if (this._rectRaf) {
      cancelAnimationFrame(this._rectRaf);
      this._rectRaf = null;
    }

    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (this.themeObserver) {
      this.themeObserver.disconnect();
    }
    document.removeEventListener('visibilitychange', this.handleVisibility);

    if (this._schemeQuery && this._onSchemeChange) {
      this._schemeQuery.removeEventListener('change', this._onSchemeChange);
    }

    if (this._motionQuery && this._onMotionChange) {
      this._motionQuery.removeEventListener('change', this._onMotionChange);
    }

    if (this._pointerMoveHandler) {
      this.element.removeEventListener('pointermove', this._pointerMoveHandler);
      this.element.removeEventListener('pointerdown', this._pointerDownHandler);
      this.element.removeEventListener('pointerleave', this._pointerLeaveHandler);
      this.element.removeEventListener('pointercancel', this._pointerLeaveHandler);
      this.element.removeEventListener('pointerenter', this._pointerEnterHandler);
    }
    this.element.style.touchAction = this.originalTouchAction || '';

    if (this._imgLoadHandler && this.imgElement) {
      this.imgElement.removeEventListener('load', this._imgLoadHandler);
    }

    this._teardownGL();
    this._restoreOriginalVisual();

    if (this.canvas && this.canvas.parentNode) {
      this.canvas.remove();
    }

    if (this._wrappedElement && this.mediaElement) {
      this.mediaElement.style.pointerEvents = this.originalMediaPointerEvents || '';
      if (this.fill) {
        this.mediaElement.style.width = this.originalMediaWidth || '';
        this.mediaElement.style.height = this.originalMediaHeight || '';
      }
      restoreMargins(this.mediaElement, this.originalMediaMargin);
      if (this.pictureElement && this.pictureElement !== this.mediaElement) {
        restoreMargins(this.pictureElement, this.originalPictureMargin);
        delete this.pictureElement._ripples;
      }
      if (this.element && this.element.parentNode) {
        this.element.parentNode.insertBefore(this._wrappedElement, this.element);
        this.element.remove();
      }
      delete this.mediaElement._ripples;
      if (this.targetElement) delete this.targetElement._ripples;
      delete this.element._ripples;
    } else {
      if (this.isAutoAspectRatio) {
        this.element.style.display = this.originalAutoDisplay || '';
        this.element.style.width = this.originalAutoWidth || '';
        this.element.style.aspectRatio = this.originalAutoAspectRatio || '';
      }
      this.element.classList.remove('webgl-ripples');
      this.element.style.position = this.originalPosition || '';
      this.element.style.isolation = this.originalIsolation || '';
      delete this.element._ripples;
    }
  }

  show() {
    this.visible = true;
    this.canvas.style.display = '';
    if (this.gl && this.backgroundWidth) {
      this._hideOriginalVisual();
    }
    this._syncFrame();
  }

  hide() {
    this.visible = false;
    this.canvas.style.display = 'none';
    this._restoreOriginalVisual(true);
  }

  pause() {
    this.running = false;
  }

  play() {
    this.running = true;
    if (this.hasActiveRipples) {
      this.wakeUp();
    } else if (this._isLiveMedia()) {
      this._startLoop();
    }
  }

  set(property, value) {
    switch (property) {
      case 'dropRadius':
        this.dropRadius = toPositive(value, this.dropRadius);
        break;
      case 'perturbance':
        this._userPerturbance = toNumber(value, this._userPerturbance);
        this.applyMotionPreference();
        this.renderSingleFrame();
        break;
      case 'interactive':
        this.interactive = Boolean(value);
        this._applyTouchAction();
        break;
      case 'lockTouch':
        this.lockTouch = Boolean(value);
        this._applyTouchAction();
        break;
      case 'crossOrigin':
        this.crossOrigin = value;
        break;
      case 'specular':
        this.specularIntensity = parseSpecular(value);
        if (this.gl && this.renderProgram) {
          this.gl.useProgram(this.renderProgram.id);
          this.gl.uniform1f(this.renderProgram.locations.specular, this.specularIntensity);
        }
        this.renderSingleFrame();
        break;
      case 'speed':
        this.speed = parseSpeed(value);
        break;
      case 'damping':
        this._userDamping = parseDamping(value);
        this.applyMotionPreference();
        break;
      case 'live':
        this.live = parseLive(value);
        if (this.gl) {
          if (this._isLiveMedia() && this.running) this._startLoop();
          else if (!this.hasActiveRipples && !this._isLiveMedia()) this._scheduleRelease();
        }
        break;
      case 'imageUrl':
        this._explicitImageUrl = Boolean(value);
        this.imageUrl = value;
        this.loadImage();
        break;
      case 'preset': {
        const preset = Ripples._resolvePreset(value);
        if (!preset) break;
        this.dropRadius = preset.dropRadius;
        this.specularIntensity = parseSpecular(preset.specular);
        this._userPerturbance = preset.perturbance;
        this._userDamping = preset.damping;
        this.speed = preset.speed;
        this.applyMotionPreference();
        if (this.gl && this.renderProgram) {
          this.gl.useProgram(this.renderProgram.id);
          this.gl.uniform1f(this.renderProgram.locations.specular, this.specularIntensity);
        }
        this.renderSingleFrame();
        break;
      }
      default:
        console.warn('[Ripples] set(): unknown or read-only property "' + property + '"');
    }
  }

  static isSupported() {
    if (typeof document === 'undefined') return false;
    if (Ripples._supported === undefined) {
      const init = initWebGL2(document.createElement('canvas'));
      Ripples._supported = Boolean(init);
      if (init) {
        Ripples._glConfig = init.config;
        const lose = init.gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    }
    return Ripples._supported;
  }

  static autoInit(options = {}) {
    if (typeof document === 'undefined') return [];
    return Array.from(document.querySelectorAll('[data-ripples]'))
      .filter(el => !el._ripples)
      .map(el => new Ripples(el, options));
  }

  static init(target, options = {}) {
    if (typeof document === 'undefined') return [];

    const isCollection = target && typeof target === 'object' && (
      target instanceof Element || target instanceof NodeList ||
      (typeof HTMLCollection !== 'undefined' && target instanceof HTMLCollection) || Array.isArray(target)
    );

    if (target === undefined || (typeof target === 'object' && target !== null && !isCollection)) {
      return Ripples.autoInit(target || options);
    }
    if (!target) return [];

    const list = typeof target === 'string'
      ? Array.from(document.querySelectorAll(target))
      : (target instanceof Element ? [target] : Array.from(target));

    return list.map(el => new Ripples(el, options));
  }
}

// Opt-in auto-initialisation: <script src="ripples.js" data-auto-init></script>
// (importing the module has no side effects otherwise; call Ripples.autoInit() yourself)
const ownScript = typeof document !== 'undefined' ? document.currentScript : null;
if (ownScript && ownScript.hasAttribute('data-auto-init')) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Ripples.autoInit());
  } else {
    setTimeout(() => Ripples.autoInit(), 0);
  }
}

export default Ripples;
export { Ripples };
