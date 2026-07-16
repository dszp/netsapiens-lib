/**
 * Browser PNG rasterizer for call-flow diagrams — Node-free, Web-APIs-only. The library never holds
 * an SVG (Mermaid renders it client-side), so this is a BROWSER helper: `resolveSvgSize` is a pure,
 * testable size reader, and `rasterizerScript()` returns injectable JS defining `svgToPngBlob`.
 * A host page (dia today; the lib's gallery HTML later) injects the script and calls the global.
 */

/** Intrinsic pixel size of an SVG string: explicit px width/height, else viewBox, else a default. */
export function resolveSvgSize(svgString: string): { width: number; height: number } {
  const DEFAULT = { width: 800, height: 600 };
  const attr = (name: string): string | undefined => {
    const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`).exec(svgString);
    return m ? m[1] : undefined;
  };
  const px = (s: string | undefined): number | null => {
    if (!s || s.includes('%')) return null; // reject "100%" etc.
    const n = parseFloat(s);                 // "120px" → 120
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const w = px(attr('width'));
  const h = px(attr('height'));
  if (w && h) return { width: w, height: h };
  const vb = attr('viewBox');
  if (vb) {
    const p = vb.trim().split(/[\s,]+/).map(Number);
    if (p.length === 4 && p[2] > 0 && p[3] > 0) return { width: w ?? p[2], height: h ?? p[3] };
  }
  return { width: w ?? DEFAULT.width, height: h ?? DEFAULT.height };
}

/**
 * Injectable browser JS (a function declaration) defining `svgToPngBlob(svgEl, { scale, background })`.
 * A host injects this string into an inline <script> (no bundler needed) and calls the function.
 * Rasterizes a LIVE, already-rendered <svg>: clone → force explicit px size (from the same algorithm
 * as resolveSvgSize) → data-URL into an Image → draw onto a scaled canvas (optional opaque background)
 * → PNG Blob. Scale is clamped so the larger dimension stays ≤ 8192px (browser canvas caps). CSP-safe
 * (no eval/new Function; uses a data: image URL — ensure any host CSP allows `img-src data:`).
 */
export function rasterizerScript(): string {
  return `
// size reader mirroring resolveSvgSize (viewBox is authoritative for Mermaid). Top-level so it is
// unit-testable outside a browser (see raster.selftest.ts) — the DOM path below is browser-only.
function __svgSize(str) {
  function attr(name){ var m = new RegExp('\\\\b'+name+'\\\\s*=\\\\s*["\\']([^"\\']*)["\\']').exec(str); return m ? m[1] : undefined; }
  function px(s){ if(!s || s.indexOf('%')>=0) return null; var n=parseFloat(s); return (isFinite(n)&&n>0)?n:null; }
  var w=px(attr('width')), h=px(attr('height'));
  if(w&&h) return {width:w,height:h};
  var vb=attr('viewBox');
  if(vb){ var p=vb.trim().split(new RegExp('[\\\\s,]+')).map(Number); if(p.length===4&&p[2]>0&&p[3]>0) return {width:(w||p[2]),height:(h||p[3])}; }
  return {width:(w||800),height:(h||600)};
}
async function svgToPngBlob(svg, opts) {
  opts = opts || {};
  var scale = opts.scale || 2;
  var background = (opts.background == null) ? null : opts.background;
  var clone = svg.cloneNode(true);
  if(!clone.getAttribute('xmlns')) clone.setAttribute('xmlns','http://www.w3.org/2000/svg');
  var size = __svgSize(new XMLSerializer().serializeToString(clone));
  var W = size.width, H = size.height;
  clone.setAttribute('width', W);
  clone.setAttribute('height', H);
  var str = new XMLSerializer().serializeToString(clone);
  // --- clamp effective scale to the canvas cap ---
  var eff = scale, MAX = 8192, big = Math.max(W, H);
  if (big * eff > MAX) eff = MAX / big;
  // --- SVG → Image → canvas → PNG ---
  var url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str);
  var img = new Image();
  await new Promise(function(res, rej){ img.onload = res; img.onerror = function(){ rej(new Error('SVG failed to load for rasterization')); }; img.src = url; });
  var canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(W * eff));
  canvas.height = Math.max(1, Math.round(H * eff));
  var ctx = canvas.getContext('2d');
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return await new Promise(function(res, rej){ canvas.toBlob(function(b){ b ? res(b) : rej(new Error('canvas.toBlob returned null')); }, 'image/png'); });
}
`.trim();
}
