/**
 * Proof for the browser PNG rasterizer's portable pieces. The size resolver is pure and unit-tested
 * here; the full Image→canvas→PNG path is browser-only (validated via agent-browser, see the plan).
 * Run: `pnpm test:raster`.
 */
import { resolveSvgSize, rasterizerScript } from './raster.js';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { cond ? (pass++, console.log('  ok   ' + name)) : (fail++, console.log('  FAIL ' + name)); };
const size = (s: string) => resolveSvgSize(s);

// ---- resolveSvgSize ----
check('explicit px width/height win', (() => { const r = size('<svg width="800" height="600" viewBox="0 0 10 10"></svg>'); return r.width === 800 && r.height === 600; })());
check('percentage width falls back to viewBox', (() => { const r = size('<svg width="100%" viewBox="0 0 812 640"></svg>'); return r.width === 812 && r.height === 640; })());
check('viewBox only', (() => { const r = size('<svg viewBox="0 0 400 300"></svg>'); return r.width === 400 && r.height === 300; })());
check('unit suffix stripped', (() => { const r = size('<svg width="120px" height="90px"></svg>'); return r.width === 120 && r.height === 90; })());
check('comma-separated viewBox', (() => { const r = size('<svg viewBox="0,0,50,40"></svg>'); return r.width === 50 && r.height === 40; })());
check('nothing → default 800x600', (() => { const r = size('<svg></svg>'); return r.width === 800 && r.height === 600; })());

// ---- rasterizerScript: must be valid JS + its emitted size logic must actually work ----
const src = rasterizerScript();
check('rasterizerScript returns non-empty string', typeof src === 'string' && src.length > 200);
check('defines svgToPngBlob', /function\s+svgToPngBlob\s*\(/.test(src));
check('emits PNG via toBlob', src.includes('toBlob') && src.includes('image/png'));
check('honors scale + background', src.includes('scale') && src.includes('background'));
check('clamps to 8192', src.includes('8192'));
check('emitted script is syntactically valid JS', (() => { try { new Function(src + '\nreturn typeof svgToPngBlob === "function";')(); return true; } catch { return false; } })());

// Execute the EMITTED __svgSize (pure string logic, no DOM) — this catches regex-escaping bugs in
// the generated code that the string-`includes` smoke checks above cannot. Mirrors resolveSvgSize.
const emittedSvgSize = new Function(src + '\nreturn __svgSize;')() as (s: string) => { width: number; height: number };
check('emitted __svgSize: viewBox-only splits on whitespace', (() => { const r = emittedSvgSize('<svg width="100%" viewBox="0 0 812 640"></svg>'); return r.width === 812 && r.height === 640; })());
check('emitted __svgSize: comma-separated viewBox', (() => { const r = emittedSvgSize('<svg viewBox="0,0,50,40"></svg>'); return r.width === 50 && r.height === 40; })());
check('emitted __svgSize: explicit px wins', (() => { const r = emittedSvgSize('<svg width="640" height="480" viewBox="0 0 10 10"></svg>'); return r.width === 640 && r.height === 480; })());
check('emitted __svgSize matches resolveSvgSize on a Mermaid-shaped SVG', (() => {
  const svg = '<svg id="m1" width="100%" viewBox="0 0 917 523" style="max-width: 917px;"></svg>';
  const a = resolveSvgSize(svg), b = emittedSvgSize(svg);
  return a.width === b.width && a.height === b.height && a.width === 917 && a.height === 523;
})());

console.log(`\nraster.selftest: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
