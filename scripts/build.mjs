// Builds dist/ from src/ripples.js (the single source of truth, an ES module):
//   ripples.mjs          ES module (bundlers, <script type="module">)
//   ripples.umd.js       UMD: CommonJS, AMD and a plain <script> global `Ripples`
//   *.min.*              minified copies
//   ripples.d.ts         TypeScript types
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { transform } from 'esbuild';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const src = readFileSync('src/ripples.js', 'utf8').replace(/\r\n/g, '\n');

const version = /static VERSION = '([^']+)'/.exec(src);
if (!version || version[1] !== pkg.version) {
  throw new Error(`Ripples.VERSION (${version && version[1]}) must match package.json version (${pkg.version})`);
}
if (!/^export default Ripples;$/m.test(src) || !/^export \{ Ripples \};$/m.test(src)) {
  throw new Error('src/ripples.js must end with "export default Ripples;" and "export { Ripples };"');
}

const banner = `/*! Ripples.js v${pkg.version} | MIT License */\n`;

const esm = banner + src;

const umdBody = src
  .replace(/^export \{ Ripples \};\n?/m, '')
  .replace(/^export default Ripples;$/m, 'return Ripples;');
const umd = banner +
`(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Ripples = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

${umdBody}
}));
`;

const min = async (code, format) =>
  (await transform(code, { minify: true, target: 'es2022', ...(format ? { format } : {}), legalComments: 'none' })).code;

const dts = readFileSync('types/ripples.d.ts', 'utf8').replace(/\r\n/g, '\n');
const dmts = dts.replace(/^export as namespace Ripples;\n?/m, '');
const dcts = dts
  .replace(/^export (interface|type) /gm, '$1 ')
  .replace(
    /^export default Ripples;\nexport \{ Ripples \};\nexport as namespace Ripples;/m,
    'declare namespace Ripples {\n  export type { RipplesOptions, RipplesSettable, RipplesEventDetail, RipplesTarget };\n}\n\nexport = Ripples;'
  );

mkdirSync('dist', { recursive: true });
writeFileSync('dist/ripples.mjs', esm);
writeFileSync('dist/ripples.umd.js', umd);
writeFileSync('dist/ripples.min.mjs', banner + await min(esm, 'esm'));
writeFileSync('dist/ripples.umd.min.js', banner + await min(umd));
writeFileSync('dist/ripples.d.ts', dts);
writeFileSync('dist/ripples.d.mts', dmts);
writeFileSync('dist/ripples.d.cts', dcts);
console.log(`built Ripples.js v${pkg.version}`);
