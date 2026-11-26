import Ripples, { RipplesOptions, RipplesPreset } from '../types/ripples';

const preset: RipplesPreset = 'calm';
const opts: RipplesOptions = { perturbance: 0, lazy: false, live: 'auto', preset, onError: (e, r) => { e.message; r.supported; } };
const [r] = Ripples.init('#hero', opts);
r.set('perturbance', 0.05);
r.set('live', false);
r.set('preset', 'glossy');
const calmDropRadius: number = Ripples.PRESETS.calm.dropRadius;
r.drop(10, 10, 30, 0.1);
const ok: boolean = Ripples.isSupported();
const el = document.querySelector('img')!;
el.addEventListener('ripples:ready', (e) => { e.detail.instance.refresh(); });
// @ts-expect-error unknown option
const bad: RipplesOptions = { nope: 1 };
// @ts-expect-error unknown preset
const badPreset: RipplesOptions = { preset: 'unknown' };
// @ts-expect-error resolution is not settable at runtime
r.set('resolution', 128);
void ok; void bad; void badPreset; void calmDropRadius;
