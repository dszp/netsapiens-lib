/**
 * FlowGraph[] -> a self-contained gallery HTML string. Portable (no Node deps): the caller
 * decides where the string goes — a file (CLI), an HTTP response (Worker), or embedded in
 * a host review page / build-preview. Mermaid renders client-side from a CDN.
 */

import type { FlowGraph } from './model.js';
import { toMermaid, type FlowTheme } from './mermaid.js';

// Pinned Mermaid build + Subresource Integrity. A floating `mermaid@11` tag lets jsDelivr serve whatever
// the latest 11.x is with NO integrity guarantee — a compromised/substituted CDN response would execute in
// the gallery (and, before the modal iframe was sandboxed, could reach the portal's ns_t). Pin an exact
// version + SRI hash so the browser refuses any bytes that don't match. Bump BOTH together — recompute:
//   curl -s https://cdn.jsdelivr.net/npm/mermaid@<v>/dist/mermaid.min.js | openssl dgst -sha384 -binary | openssl base64 -A
const MERMAID_VERSION = '11.16.0';
const MERMAID_CDN = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`;
const MERMAID_SRI = 'sha384-T/0lMUdJpd2S1ZHtRiofG3htU3xPCrFVeAQ1UUE2TJwlEJSV5NUwn30kP28n238E';

/** Build the Mermaid `<script>` tag. For the pinned jsDelivr build (the default) attach `integrity` +
 *  `crossorigin` so the browser rejects a substituted CDN payload. A caller-supplied self-hosted `src`
 *  is emitted WITHOUT SRI — the caller owns that origin's integrity, and its bytes won't match this hash. */
function mermaidScriptTag(src?: string): string {
  const url = src ?? MERMAID_CDN;
  const sri = url === MERMAID_CDN ? ` integrity="${MERMAID_SRI}" crossorigin="anonymous"` : '';
  return `<script src="${escapeHtml(url)}"${sri}></script>`;
}

/** Left-align multi-line node content (agent / device / queue lists) + edge labels so they read as
 *  lists, not centered blobs. Hosts include this wherever `.mermaid` diagrams render. */
const FLOW_LABEL_CSS = `.mermaid g.agents div, .mermaid g.agents span, .mermaid g.agents p,
  .mermaid g.devices div, .mermaid g.devices span, .mermaid g.devices p,
  .mermaid g.queue div, .mermaid g.queue span, .mermaid g.queue p { text-align:left !important; }
  .mermaid .edgeLabel div, .mermaid .edgeLabel span, .mermaid .edgeLabel p { text-align:left !important; }
  /* Edge-label chips — keep them TIGHT. Mermaid gives the label foreignObject a tall line-height and a
     semi-transparent .labelBkg; once overflow:visible stops the right-edge clip (it under-measures width
     under look:neo, so "press 2" got cut), that block showed as an oversized blocky highlight and short
     labels even wrapped. So: drop the block bg, force single-line (explicit <br/> in multi-option labels
     still breaks), and render the text as a compact rounded chip with a little space before/after.
     mermaid.ts drops the old trailing-nbsp slack in favor of this. */
  .mermaid g.edgeLabel foreignObject { overflow:visible; }
  .mermaid .edgeLabel .labelBkg { background:transparent !important; }
  .mermaid .edgeLabel foreignObject > div { white-space:nowrap !important; line-height:1.35 !important; max-width:none !important; }
  .mermaid span.edgeLabel { display:inline-block; padding:1px 7px; border-radius:4px; line-height:1.35; white-space:nowrap; }`;

/** Shared flowchart layout config. Node clipping is prevented by nbsp label slack in mermaid.ts,
 *  not by padding — so this keeps Mermaid's default node padding (a larger override made wide nodes
 *  like AAs balloon). */
const FLOWCHART_CFG = `htmlLabels:true, curve:'basis', nodeSpacing:45, rankSpacing:55`;

/** Escapes for BOTH text and quoted-attribute contexts — `mermaidScriptTag` interpolates into
 *  `src="…"`, so omitting the quote entities made `escapeHtml(url)` look safe while allowing
 *  `x.js" onload="…`. Over-escaping in text position is inert, so one function covers both. */
function escapeHtml(t: string): string {
  return String(t)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function cap(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1);
}
/** Stable, collision-safe DOM id for a flow card so a host page can deep-link one diagram.
 *  `kind` is sanitized alongside `ref`: resolveFlow only ever emits the four literals, but
 *  FlowGraph.entity.kind is typed `string` and hand-built graphs are a supported use, so an
 *  unsanitized kind would land unescaped in `id="…"`/`href="#…"`. */
export function flowAnchorId(g: FlowGraph): string {
  const safe = (s: unknown) => String(s).replace(/[^A-Za-z0-9_-]/g, '-');
  return `flow-${safe(g.entity.kind)}-${safe(g.entity.ref)}`;
}

/** A CSS color safe to interpolate into a `<style>` block. Anything else is refused rather than
 *  escaped: `accent` is documented as host-supplied config, and a white-label host that sources it
 *  per-tenant would otherwise hand any tenant a `</style><script>` breakout. Callers that were
 *  already passing hex (the documented contract) see no change. */
function safeAccent(accent: string | undefined, fallback: string): string {
  return accent && /^#[0-9a-fA-F]{3,8}$/.test(accent) ? accent : fallback;
}

export interface CardOptions {
  /** Themed rendering (light/dark palette + `look: neo` + a card anchor id). OMIT for the
   *  legacy dark card with no frontmatter and no id — the Worker relies on that being unchanged. */
  theme?: FlowTheme;
  /** Render the card as a collapsible `<details>` (gallery navigation). */
  collapsible?: boolean;
  /** When collapsible, start expanded. */
  open?: boolean;
  /** When collapsible, add a "↑ top" link in the summary. */
  backToTop?: boolean;
}

export interface GalleryOptions extends CardOptions {
  /** Load Mermaid from this URL (CDN by default). Override to self-host / inline for CSP. */
  mermaidSrc?: string;
  /** Extra note shown under the title. */
  subtitle?: string;
  /** Brand accent for subtle highlights — links, the "Legend:" lead, the card's top rule, and the
   *  pan/zoom controls' hover. Themed path only; defaults to the theme's link color. Pass your own
   *  brand color here (from your host's config) rather than baking one into a theme, e.g.
   *  `accent: '#1a6bb0'`.
   *
   *  MUST be a CSS hex color (`#rgb` … `#rrggbbaa`); this value is interpolated into a `<style>`
   *  block, so anything else is IGNORED in favour of the theme's link color rather than escaped.
   *  If you source it per-tenant, that rejection is the only thing between a hostile value and a
   *  `</style><script>` breakout — don't defeat it by pre-formatting the string. */
  accent?: string;
  /** Themed galleries only: anchor ids ({@link flowAnchorId}) to render pre-expanded. Cards not in
   *  the set render collapsed. A themed gallery is always collapsible with a table-of-contents. */
  expand?: Set<string>;
}

/** Render one flow as a gallery `<section>` card. Themed cards carry an `id` anchor
 *  ({@link flowAnchorId}); the legacy (no-theme) card is byte-identical to the original. */
export function renderFlowCard(g: FlowGraph, opts: CardOptions = {}): string {
  const notes = g.notes.length ? `<ul class="cf-notes">${g.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : '';
  const mermaid = `<div class="mermaid">${escapeHtml(toMermaid(g, opts.theme ? { theme: opts.theme } : undefined))}</div>`;
  const title = `${escapeHtml(g.entity.kind === 'did' ? 'DID' : cap(g.entity.kind))}: ${escapeHtml(g.entity.label)}`;
  if (opts.collapsible) {
    const back = opts.backToTop ? ` <a class="cf-top" href="#cf-top" onclick="event.stopPropagation()">↑ top</a>` : '';
    return `<details class="cf-card"${opts.theme ? ` id="${flowAnchorId(g)}"` : ''}${opts.open ? ' open' : ''}>
      <summary><span class="cf-title">${title}</span><span class="cf-meta"> · ${g.nodes.length} nodes · ${g.edges.length} edges</span>${back}</summary>
      ${mermaid}
      ${notes}
    </details>`;
  }
  const idAttr = opts.theme ? ` id="${flowAnchorId(g)}"` : '';
  return `<section class="cf-card"${idAttr}>
      <h2>${title}</h2>
      <div class="cf-meta">${g.nodes.length} nodes · ${g.edges.length} edges</div>
      ${mermaid}
      ${notes}
    </section>`;
}

/** Render the gallery `<section>` cards only (no page chrome) — for embedding in another page. */
export function renderFlowCards(graphs: FlowGraph[], opts: CardOptions = {}): string {
  return graphs.map((g) => renderFlowCard(g, opts)).join('\n');
}

/**
 * The `<script>` tags a host page needs to render embedded `.mermaid` blocks itself
 * (e.g. a review report). `securityLevel: 'strict'` is MANDATORY — it is the
 * second escaping layer `mermaid.ts` depends on; do not make it caller-configurable.
 */
export function mermaidBootstrap(opts: { theme?: FlowTheme; mermaidSrc?: string } = {}): string {
  const mermaidTheme = opts.theme === 'light' ? 'base' : 'dark';
  return `<style>${FLOW_LABEL_CSS}</style>
${mermaidScriptTag(opts.mermaidSrc)}
<script>mermaid.initialize({ startOnLoad:true, theme:'${mermaidTheme}', securityLevel:'strict', flowchart:{ ${FLOWCHART_CFG} } });</script>`;
}

/** Full standalone HTML document for a set of flows. */
export function renderGalleryHtml(domain: string, graphs: FlowGraph[], opts: GalleryOptions = {}): string {
  const mermaidSrc = opts.mermaidSrc ?? MERMAID_CDN;
  const subtitle = opts.subtitle ?? `resolved from snapshot · ${graphs.length} flows`;
  // Themed path (light for a review context, or explicit dark-neo). No theme → the original dark
  // document below, byte-identical (the Worker depends on this).
  if (opts.theme) return themedGalleryHtml(domain, graphs, mermaidSrc, subtitle, opts.theme, opts.expand, opts.accent);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Call Flows — ${escapeHtml(domain)}</title>
${mermaidScriptTag(mermaidSrc)}
<style>
  :root { color-scheme: dark; }
  body { background:#0f1115; color:#e6e6e6; font:15px/1.5 system-ui,sans-serif; margin:0; padding:24px; }
  h1 { font-size:14px; font-weight:600; color:#8a94a6; margin:0 0 2px; }
  .cf-sub { color:#e6e6e6; margin:0 0 24px; font-size:18px; font-weight:700; }
  .cf-card { background:#161a22; border:1px solid #232a36; border-radius:12px; padding:18px 20px; margin:0 0 22px; }
  .cf-card h2 { font-size:16px; margin:0 0 2px; }
  .cf-meta { color:#7b8494; font-size:12px; margin-bottom:12px; }
  .mermaid { background:#0c0e12; border-radius:8px; padding:14px; overflow:auto; text-align:center; }
  ${FLOW_LABEL_CSS}
  .cf-notes { margin:12px 0 0; padding-left:18px; color:#c9a24a; font-size:12.5px; }
  .cf-notes li { margin:2px 0; }
  .cf-legend { display:flex; align-items:center; flex-wrap:wrap; gap:10px; margin:0 0 22px; font-size:12px; color:#aab; }
  .cf-legend span { background:#161a22; border:1px solid #232a36; border-radius:6px; padding:3px 8px; }
  .cf-legend-lead { font-weight:700; }
  .mermaid { cursor:zoom-in; }
  .cf-lightbox { position:fixed; inset:0; background:rgba(6,8,12,.95); display:none; z-index:9999; padding:20px; cursor:zoom-out; }
  .cf-lightbox.open { display:block; }
  .cf-lightbox-inner { width:100%; height:100%; overflow:auto; display:flex; align-items:flex-start; justify-content:center; }
  .cf-lightbox-inner svg { max-width:none !important; height:auto; }
  .cf-lightbox-hint { position:fixed; top:10px; right:16px; color:#8a94a6; font-size:12px; pointer-events:none; }
</style></head>
<body>
  <h1>Call Flow Diagram — ${escapeHtml(domain)}</h1>
  <p class="cf-sub">${escapeHtml(subtitle)}</p>
  <div class="cf-legend">
    <b class="cf-legend-lead">Legend:</b><span>📞 DID</span><span>🕒 time-of-day</span><span>👤 user</span><span>📱 ring devices</span>
    <span>📋 queue</span><span>👥 agents</span><span>🔀 auto attendant</span><span>🔊 prompt</span>
    <span>📭 voicemail</span><span>☎️ external</span>
  </div>
  ${renderFlowCards(graphs)}
  <div id="cf-lightbox" class="cf-lightbox"><span class="cf-lightbox-hint">click / Esc to close</span><div class="cf-lightbox-inner"></div></div>
  <script>
    mermaid.initialize({ startOnLoad:true, theme:'dark', securityLevel:'strict', flowchart:{ ${FLOWCHART_CFG} } });
    // Click any diagram to enlarge it in a scrollable overlay; click anywhere / Esc to close.
    (function(){
      var box = document.getElementById('cf-lightbox');
      var inner = box.querySelector('.cf-lightbox-inner');
      function close(){ box.classList.remove('open'); inner.replaceChildren(); }
      document.addEventListener('click', function(e){
        var card = e.target.closest ? e.target.closest('.mermaid') : null;
        if (card && !box.contains(card)) {
          var svg = card.querySelector('svg');
          if (!svg) return;
          var clone = svg.cloneNode(true);
          clone.removeAttribute('height'); clone.removeAttribute('style');
          inner.replaceChildren(clone);
          box.classList.add('open');
        } else if (box.classList.contains('open')) {
          close();
        }
      });
      document.addEventListener('keydown', function(e){ if (e.key === 'Escape') close(); });
    })();
  </script>
</body></html>`;
}

/** Themed gallery document — light (review context) or explicit dark-neo. Parallel to
 *  the legacy dark document in {@link renderGalleryHtml}; kept separate so that path stays byte-identical. */
function themedGalleryHtml(
  domain: string,
  graphs: FlowGraph[],
  mermaidSrc: string,
  subtitle: string,
  theme: FlowTheme,
  expand?: Set<string>,
  accent?: string,
): string {
  const light = theme === 'light';
  const c = light
    ? { scheme: 'light', pageBg: '#fafafa', text: '#1e293b', sub: '#64748b', cardBg: '#ffffff', cardBorder: '#e2e8f0', meta: '#64748b', mermaidBg: '#f8fafc', notes: '#b45309', legendText: '#475569', legendBg: '#ffffff', lightboxBg: 'rgba(248,250,252,.96)', hint: '#64748b', shadow: 'box-shadow:0 1px 2px rgba(0,0,0,.04);', link: '#21618c' }
    : { scheme: 'dark', pageBg: '#0f1115', text: '#e6e6e6', sub: '#8a94a6', cardBg: '#161a22', cardBorder: '#232a36', meta: '#7b8494', mermaidBg: '#0c0e12', notes: '#c9a24a', legendText: '#aab', legendBg: '#161a22', lightboxBg: 'rgba(6,8,12,.95)', hint: '#8a94a6', shadow: '', link: '#7db3e6' };
  const initTheme = light ? 'base' : 'dark';
  const brandAccent = safeAccent(accent, c.link);
  const single = graphs.length === 1; // a one-flow gallery (e.g. the portal modal) needs no contents nav
  const isOpen = (g: FlowGraph) => single || (!!expand && expand.has(flowAnchorId(g)));

  // Table of contents grouped by entity kind; ● marks the pre-expanded (notable) flows.
  const KIND_LABEL: Record<string, string> = { did: '📞 DIDs', user: '👤 Users', queue: '📋 Queues', attendant: '🔀 Auto Attendants' };
  const byKind = new Map<string, FlowGraph[]>();
  for (const g of graphs) {
    const k = g.entity.kind;
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k)!.push(g);
  }
  const toc = [...byKind.entries()]
    .map(
      ([kind, gs]) => `<div class="cf-toc-group"><div class="cf-toc-h">${KIND_LABEL[kind] ?? escapeHtml(cap(kind))}</div>
    <ul>${gs
      .map((g) => `<li>${isOpen(g) ? '<b>●</b> ' : ''}<a href="#${flowAnchorId(g)}">${escapeHtml(g.entity.label)}</a></li>`)
      .join('')}</ul></div>`,
    )
    .join('\n');

  // A single-flow gallery (portal modal) renders as a fixed, non-collapsible card; multi-flow keeps the
  // collapsible <details> for navigation.
  const cards = graphs.map((g) => renderFlowCard(g, { theme, collapsible: !single, open: isOpen(g), backToTop: !single })).join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Call Flows — ${escapeHtml(domain)}</title>
${mermaidScriptTag(mermaidSrc)}
<style>
  :root { color-scheme: ${c.scheme}; scroll-behavior:smooth; }
  body { background:${c.pageBg}; color:${c.text}; font:15px/1.5 system-ui,sans-serif; margin:0; padding:24px; }
  a { color:${brandAccent}; }
  h1 { font-size:14px; font-weight:600; color:${c.sub}; margin:0 0 2px; }
  .cf-sub { color:${c.text}; margin:0 0 18px; font-size:18px; font-weight:700; }
  .cf-legend { display:flex; align-items:center; flex-wrap:wrap; gap:10px; margin:0 0 18px; font-size:12px; color:${c.legendText}; }
  .cf-legend span { background:${c.legendBg}; border:1px solid ${c.cardBorder}; border-radius:6px; padding:3px 8px; }
  .cf-legend-lead { font-weight:700; color:${brandAccent}; }
  .cf-toc { background:${c.cardBg}; border:1px solid ${c.cardBorder}; border-radius:12px; padding:14px 18px; margin:0 0 22px; ${c.shadow} }
  .cf-toc-top { font-weight:700; font-size:13px; margin:0 0 8px; }
  .cf-toc-cols { display:flex; flex-wrap:wrap; gap:8px 28px; }
  .cf-toc-group { min-width:160px; }
  .cf-toc-h { font-size:12px; font-weight:700; color:${c.sub}; margin:4px 0 2px; }
  .cf-toc ul { margin:0 0 6px; padding-left:16px; font-size:13px; }
  .cf-toc li { margin:1px 0; }
  .cf-card { background:${c.cardBg}; border:1px solid ${c.cardBorder}; border-radius:12px; padding:0; margin:0 0 14px; ${c.shadow} scroll-margin-top:12px; }
  section.cf-card { padding:12px 18px; border-top:3px solid ${brandAccent}; }
  section.cf-card > h2 { font-size:16px; margin:0 0 2px; }
  details.cf-card > summary { cursor:pointer; padding:12px 18px; font-size:15px; font-weight:700; list-style:none; user-select:none; }
  details.cf-card > summary::-webkit-details-marker { display:none; }
  details.cf-card > summary::before { content:'▸ '; color:${c.sub}; font-weight:400; }
  details.cf-card[open] > summary::before { content:'▾ '; }
  details.cf-card[open] > summary { border-bottom:1px solid ${c.cardBorder}; }
  .cf-title { }
  .cf-meta { color:${c.meta}; font-size:12px; font-weight:400; }
  .cf-top { float:right; font-size:11px; font-weight:400; }
  details.cf-card > .mermaid, details.cf-card > .cf-notes { margin:0 18px; }
  .mermaid { background:${c.mermaidBg}; border-radius:8px; padding:14px; margin:14px 0; overflow:auto; text-align:center; cursor:zoom-in; }
  .mermaid.cf-pz { overflow:hidden; cursor:grab; position:relative; text-align:left; padding:0; height:70vh; touch-action:none; }
  .mermaid.cf-pz svg { position:absolute; top:0; left:0; max-width:none !important; height:auto; }
  .cf-pz-ctl { position:absolute; top:10px; right:10px; display:flex; flex-direction:column; gap:5px; z-index:5; }
  .cf-pz-ctl button { width:30px; height:30px; border:1px solid ${c.cardBorder}; background:${c.cardBg}; color:${c.text}; border-radius:6px; cursor:pointer; font:16px/1 system-ui,sans-serif; ${c.shadow} }
  .cf-pz-ctl button:hover { border-color:${brandAccent}; color:${brandAccent}; }
  ${FLOW_LABEL_CSS}
  .cf-notes { padding:0 0 14px 34px; color:${c.notes}; font-size:12.5px; }
  .cf-notes li { margin:2px 0; }
  .cf-lightbox { position:fixed; inset:0; background:${c.lightboxBg}; display:none; z-index:9999; padding:20px; cursor:zoom-out; }
  .cf-lightbox.open { display:block; }
  .cf-lightbox-inner { width:100%; height:100%; overflow:auto; display:flex; align-items:flex-start; justify-content:center; }
  .cf-lightbox-inner svg { max-width:none !important; height:auto; }
  .cf-lightbox-hint { position:fixed; top:10px; right:16px; color:${c.hint}; font-size:12px; pointer-events:none; }
</style></head>
<body>
  <span id="cf-top"></span>
  <h1>Call Flow Diagram — ${escapeHtml(domain)}</h1>
  <p class="cf-sub">${escapeHtml(subtitle)}</p>
  <div class="cf-legend">
    <b class="cf-legend-lead">Legend:</b><span>📞 DID</span><span>🕒 time-of-day</span><span>👤 user</span><span>📱 ring devices</span>
    <span>📋 queue</span><span>👥 agents</span><span>🔀 auto attendant</span><span>🔊 prompt</span>
    <span>📭 voicemail</span><span>☎️ external</span>
  </div>
  ${single ? '' : `<nav class="cf-toc">
    <div class="cf-toc-top">Contents <span class="cf-meta">(● = notable / pre-expanded)</span></div>
    <div class="cf-toc-cols">${toc}</div>
  </nav>`}
  ${cards}
  <div id="cf-lightbox" class="cf-lightbox"><span class="cf-lightbox-hint">click / Esc to close</span><div class="cf-lightbox-inner"></div></div>
  ${mermaidBootstrapInline(initTheme)}
</body></html>`;
}

/** The gallery's own Mermaid init + lightbox script (self-contained; not the host-page bootstrap). */
function mermaidBootstrapInline(initTheme: string): string {
  return `<script>
    mermaid.initialize({ startOnLoad:false, theme:'${initTheme}', securityLevel:'strict', flowchart:{ ${FLOWCHART_CFG} } });
    document.querySelectorAll('.mermaid').forEach(function(el){ if(!el.getAttribute('data-src')){ el.setAttribute('data-src', el.textContent); } });
    mermaid.run({ querySelector:'.mermaid' }).then(function(){
      var els = document.querySelectorAll('.mermaid');
      // Single-flow (the portal modal): scroll/drag pan, Shift+scroll or +/- buttons zoom, flip layout.
      if (els.length === 1) { panZoom(els[0]); } else { lightbox(); }
    });
    function panZoom(el){
      var svg = el.querySelector('svg'); if(!svg) return;
      el.classList.add('cf-pz');
      // Pin the SVG to its natural viewBox pixel size so our transform (not mermaid's width:100% +
      // viewBox auto-scaling) fully controls the displayed size — otherwise fit measurements are wrong.
      var vb=(svg.viewBox&&svg.viewBox.baseVal)||{};
      var natW=vb.width||svg.getBoundingClientRect().width, natH=vb.height||svg.getBoundingClientRect().height;
      svg.setAttribute('width', natW); svg.setAttribute('height', natH); svg.style.maxWidth='none'; svg.style.transformOrigin='0 0';
      var st = el._pz || (el._pz = {}); st.svg=svg; st.natW=natW; st.natH=natH; st.k=1; st.tx=0; st.ty=0; st.drag=false;
      st.apply = function(){ svg.style.transform='translate('+st.tx+'px,'+st.ty+'px) scale('+st.k+')'; };
      st.fit = function(){
        var r=el.getBoundingClientRect(), w=st.natW||r.width, h=st.natH||r.height;
        var pad=16, lr=/flowchart\\s+(LR|RL)/.test(el.getAttribute('data-src')||'');
        // Fill the primary axis (TD → width, LR → height); never upscale past natural (1x) so small
        // few-node diagrams don't balloon. Center the cross-axis; start-align the overflowing one.
        st.k=Math.min(lr?(r.height-pad)/h:(r.width-pad)/w, 1); if(!isFinite(st.k)||st.k<=0){ st.k=1; }
        if(lr){ st.ty=(r.height-h*st.k)/2; st.tx=(w*st.k>r.width)?pad:(r.width-w*st.k)/2; }
        else { st.tx=(r.width-w*st.k)/2; st.ty=(h*st.k>r.height)?pad:(r.height-h*st.k)/2; }
        st.apply();
      };
      st.zoomAt = function(f, cx, cy){ var nk=Math.max(0.2,Math.min(6,st.k*f)), r=nk/st.k; st.tx=cx-(cx-st.tx)*r; st.ty=cy-(cy-st.ty)*r; st.k=nk; st.apply(); };
      function flip(){
        var src=el.getAttribute('data-src')||'';
        var cur=(src.match(/flowchart\\s+(TB|TD|LR|RL|BT)/)||[])[1]||'TD';
        var next=(cur==='LR'||cur==='RL')?'TD':'LR';
        el.setAttribute('data-src', src.replace(/flowchart\\s+(TB|TD|LR|RL|BT)/, 'flowchart '+next));
        var oc=el.querySelector('.cf-pz-ctl'); if(oc){ oc.remove(); }
        el.classList.remove('cf-pz'); el.removeAttribute('data-processed'); el.textContent=el.getAttribute('data-src');
        mermaid.run({ nodes:[el] }).then(function(){ panZoom(el); });
      }
      var oldc=el.querySelector('.cf-pz-ctl'); if(oldc){ oldc.remove(); }
      var ctl=document.createElement('div'); ctl.className='cf-pz-ctl';
      function mk(t,tip,f){ var b=document.createElement('button'); b.type='button'; b.textContent=t; b.title=tip; b.addEventListener('click', function(e){ e.stopPropagation(); f(); }); ctl.appendChild(b); }
      mk('+','Zoom in', function(){ st.zoomAt(1.2, el.clientWidth/2, 0); });
      mk('−','Zoom out', function(){ st.zoomAt(1/1.2, el.clientWidth/2, 0); });
      mk('↺','Reset view', function(){ st.fit(); });
      mk('⇄','Flip layout (horizontal / vertical)', flip);
      el.appendChild(ctl);
      if(!el._pzBound){
        el._pzBound=true;
        el.addEventListener('wheel', function(e){
          e.preventDefault();
          if(e.shiftKey){ var d=e.deltaY||e.deltaX, r=el.getBoundingClientRect(); st.zoomAt(d<0?1.1:1/1.1, e.clientX-r.left, e.clientY-r.top); }
          else { st.tx-=e.deltaX; st.ty-=e.deltaY; st.apply(); }
        }, {passive:false});
        el.addEventListener('pointerdown', function(e){ if(e.target.closest && e.target.closest('.cf-pz-ctl')){ return; } st.drag=true; st.px=e.clientX; st.py=e.clientY; try{ el.setPointerCapture(e.pointerId); }catch(_){} el.style.cursor='grabbing'; });
        el.addEventListener('pointermove', function(e){ if(!st.drag){ return; } st.tx+=e.clientX-st.px; st.ty+=e.clientY-st.py; st.px=e.clientX; st.py=e.clientY; st.apply(); });
        var end=function(){ st.drag=false; el.style.cursor='grab'; };
        el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
        window.addEventListener('resize', function(){ if(st.fit){ st.fit(); } });
      }
      requestAnimationFrame(function(){ st.fit(); }); setTimeout(function(){ st.fit(); }, 80);
    }
    function lightbox(){
      var box = document.getElementById('cf-lightbox'); if(!box){ return; }
      var inner = box.querySelector('.cf-lightbox-inner');
      function close(){ box.classList.remove('open'); inner.replaceChildren(); }
      document.addEventListener('click', function(e){
        var card = e.target.closest ? e.target.closest('.mermaid') : null;
        if (card && !box.contains(card)) {
          var svg = card.querySelector('svg'); if (!svg) return;
          var clone = svg.cloneNode(true); clone.removeAttribute('height'); clone.removeAttribute('style');
          inner.replaceChildren(clone); box.classList.add('open');
        } else if (box.classList.contains('open')) { close(); }
      });
      document.addEventListener('keydown', function(e){ if (e.key === 'Escape') close(); });
    }
  </script>`;
}
