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
 * Injectable browser JS (function declarations) defining `svgToPngBlob(svgEl, { scale, background })`
 * and `svgToSvgBlob(svgEl, { background })`. A host injects this string into an inline <script> (no
 * bundler needed) and calls the functions on a LIVE, already-rendered <svg>.
 * Both start from the same standalone copy: clone → drop on-screen sizing/transform styles → copy
 * every CSS custom property the SVG references (`var(--x)`) from the live element's computed style
 * onto the clone, because the file is rendered standalone and cannot inherit the host page's
 * variables (Pele colors everything through them) → replace each `var()` in attributes and styles with
 * the live element's computed value and drop the custom properties, so viewers without CSS-variable
 * support (librsvg, editors) draw it too → force explicit px size (from the same algorithm
 * as resolveSvgSize). The SVG export adds the optional background as a first-child rect, since SVG
 * viewers ignore a CSS background on the root. The PNG export puts the copy in a data-URL Image →
 * draws it onto a scaled canvas (optional opaque background) → PNG Blob. Scale is clamped so the larger dimension stays ≤ 8192px (browser canvas caps). CSP-safe
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
// Custom property names an SVG string references via var(--name …), de-duplicated, in order.
function __cssVarNames(str) {
  var re=new RegExp('var\\\\(\\\\s*(--[A-Za-z0-9_-]+)','g'), seen={}, out=[], m;
  while((m=re.exec(str))){ if(!seen[m[1]]){ seen[m[1]]=1; out.push(m[1]); } }
  return out;
}
function __standaloneSvg(svg) {
  var clone = svg.cloneNode(true);
  if(!clone.getAttribute('xmlns')) clone.setAttribute('xmlns','http://www.w3.org/2000/svg');
  ['transform','transform-origin','position','top','left','max-width','width','height'].forEach(function(p){ clone.style.removeProperty(p); });
  var cs = getComputedStyle(svg);
  __cssVarNames(new XMLSerializer().serializeToString(clone)).forEach(function(n){
    var v = cs.getPropertyValue(n).trim(); if (v) clone.style.setProperty(n, v);
  });
  // Then replace every var() with the live element's computed value. Browsers resolve var() in
  // presentation attributes (stroke="var(--x)"), but librsvg and editing tools do not: a saved file
  // would lose its edges and edge-label text. The clone and the live SVG walk in the same order.
  var live = [svg].concat([].slice.call(svg.querySelectorAll('*')));
  var copy = [clone].concat([].slice.call(clone.querySelectorAll('*')));
  for (var i = 0; i < copy.length && i < live.length; i++) {
    var lc = getComputedStyle(live[i]), c = copy[i];
    [].slice.call(c.attributes).forEach(function(a){
      if (a.name !== 'style' && a.value.indexOf('var(') >= 0) { var v = lc.getPropertyValue(a.name).trim(); if (v) c.setAttribute(a.name, v); }
    });
    if (c.style) {
      for (var j = c.style.length - 1; j >= 0; j--) {
        var pn = c.style[j];
        if (pn.indexOf('--') === 0) { c.style.removeProperty(pn); continue; }
        if (c.style.getPropertyValue(pn).indexOf('var(') >= 0) { var pv = lc.getPropertyValue(pn).trim(); if (pv) c.style.setProperty(pn, pv); }
      }
    }
  }
  var size = __svgSize(new XMLSerializer().serializeToString(clone));
  var W = size.width, H = size.height;
  clone.setAttribute('width', W);
  clone.setAttribute('height', H);
  return { el: clone, width: W, height: H };
}
function svgToSvgBlob(svg, opts) {
  opts = opts || {};
  var s = __standaloneSvg(svg), el = s.el;
  if (opts.background) {
    var vb = el.viewBox && el.viewBox.baseVal && el.viewBox.baseVal.width ? el.viewBox.baseVal : { x: 0, y: 0, width: s.width, height: s.height };
    var r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('x', vb.x); r.setAttribute('y', vb.y); r.setAttribute('width', vb.width); r.setAttribute('height', vb.height); r.setAttribute('fill', opts.background);
    el.insertBefore(r, el.firstChild);
  }
  return new Blob(['<?xml version="1.0" encoding="UTF-8"?>\\n' + new XMLSerializer().serializeToString(el)], { type: 'image/svg+xml' });
}
async function svgToPngBlob(svg, opts) {
  opts = opts || {};
  var scale = opts.scale || 2;
  var background = (opts.background == null) ? null : opts.background;
  var s = __standaloneSvg(svg), W = s.width, H = s.height;
  var str = new XMLSerializer().serializeToString(s.el);
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
