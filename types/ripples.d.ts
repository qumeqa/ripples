export type RipplesPreset = 'default' | 'subtle' | 'calm' | 'glossy' | 'viscous';

export interface RipplesOptions {
  /** Image or video URL to distort. Default: the element's own media source or CSS background-image. */
  imageUrl?: string | null;
  /** Named parameter preset applied before individual overrides. Default null. */
  preset?: RipplesPreset | null;
  /** Simulation grid size (power of two works best). Default 256. */
  resolution?: number;
  /** Drop radius in px for an element with a 1200px longest side; scales 0.5x–1.3x with element size. Default 30. */
  dropRadius?: number;
  /** Refraction strength. 0 disables refraction. Default 0.05. */
  perturbance?: number;
  /** React to pointer movement / clicks. Default true. */
  interactive?: boolean;
  /** Prevent page scrolling while dragging on touchscreens (sets touch-action: none). Default false. */
  lockTouch?: boolean;
  /** crossOrigin attribute for remote media, or null to disable. Default 'anonymous'. */
  crossOrigin?: string | null;
  /** Specular highlight: false/0 disables, true = 1.0, or an intensity. Default 0.2. */
  specular?: boolean | number;
  /** Wave damping, 0.8–0.999. Default 0.975. */
  damping?: number;
  /** Simulation speed multiplier, >= 0.1. Default 1. */
  speed?: number;
  /** Sleep (no CPU/GPU) once the ripples have settled. Default true. */
  autoPause?: boolean;
  /** Device pixel ratio used for the canvas and SVG rasterisation. Default 'auto' (capped at 2). */
  dpr?: 'auto' | number;
  /** Create the WebGL context on first interaction instead of at init. Default true. */
  lazy?: boolean;
  /** <img>, <picture>, <video>, <canvas>: stretch to wrapper. false keeps the element's CSS size. Default true. */
  fill?: boolean;
  /** Continuously re-upload frames for dynamic sources (<video>, <canvas>). 'auto' tracks playing video and <canvas>. Default 'auto'. */
  live?: 'auto' | boolean;
  /** Call refresh() when <html> class / data-theme / prefers-color-scheme changes. Default false. */
  watchTheme?: boolean;
  /** Free the WebGL context shortly after the ripples settle; recreated on next hover. Default true. */
  releaseOnIdle?: boolean;
  /** Milliseconds between "settled" and releasing the context. Default 4000. */
  releaseDelay?: number;
  /** Create the context in an idle moment once the element is visible. Default false. */
  prewarm?: boolean;
  /** Called once the image is uploaded and the effect is live. */
  onReady?: ((instance: Ripples) => void) | null;
  /** Called when WebGL 2 is unavailable, a shader fails, or the image cannot be loaded. */
  onError?: ((error: Error, instance: Ripples) => void) | null;
}

/** Properties that can be changed at runtime with set(). */
export type RipplesSettable =
  | 'dropRadius' | 'perturbance' | 'interactive' | 'lockTouch' | 'crossOrigin'
  | 'specular' | 'speed' | 'damping' | 'live' | 'imageUrl' | 'preset';

export interface RipplesEventDetail {
  instance: Ripples;
  error: Error | null;
}

export type RipplesTarget = string | Element | ArrayLike<Element>;

declare class Ripples {
  static readonly VERSION: string;
  /** Soft cap on simultaneously live WebGL contexts. Default 8. */
  static maxContexts: number;
  static readonly PRESETS: Readonly<Record<
    RipplesPreset,
    Readonly<Required<Pick<RipplesOptions, 'perturbance' | 'dropRadius' | 'damping' | 'speed' | 'specular'>>>
  >>;
  static readonly DEFAULTS: Readonly<RipplesOptions>;

  /** Whether WebGL 2 with half-float render targets is available (cached). */
  static isSupported(): boolean;
  /** Initialises every [data-ripples] element that has no instance yet. */
  static autoInit(options?: RipplesOptions): Ripples[];
  /** Always returns an array of instances (empty when nothing matched). */
  static init(target?: RipplesTarget | RipplesOptions, options?: RipplesOptions): Ripples[];

  constructor(element: string | Element, options?: RipplesOptions);

  readonly element: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  /** false when the effect could not start (the original DOM is restored). */
  readonly supported: boolean;
  readonly destroyed: boolean;

  /** Creates the WebGL context now. Returns true when the effect is ready to use. */
  activate(): boolean;
  /** Frees the WebGL context and shows the original image; recreated on next interaction. */
  release(): void;
  /** Adds a drop at element-relative CSS pixels. */
  drop(x: number, y: number, radius?: number, strength?: number): void;
  set(property: RipplesSettable, value: unknown): void;
  pause(): void;
  play(): void;
  show(): void;
  hide(): void;
  updateSize(): void;
  /** Re-reads the media source (<img>/<picture> currentSrc, <video>, <canvas>, or CSS background-image) and redraws. */
  refresh(): void;
  destroy(): void;
}

export default Ripples;
export { Ripples };
export as namespace Ripples;

declare global {
  interface HTMLElementEventMap {
    'ripples:ready': CustomEvent<RipplesEventDetail>;
    'ripples:error': CustomEvent<RipplesEventDetail>;
  }
}
