/**
 * Gallery HTML: which renderer each path loads, and that host-supplied strings cannot break out of
 * the inline script. The drawing, PNG and print paths are browser-only (validated in a browser).
 * Run: `pnpm test:html`.
 */
import { renderGalleryHtml, peleScriptTag, svgSanitizerScript, letterPrintScript } from './html.js';
import type { FlowGraph } from './model.js';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { cond ? (pass++, console.log('  ok   ' + name)) : (fail++, console.log('  FAIL ' + name)); };

const g: FlowGraph = {
  entity: { kind: 'queue', ref: '9100', label: 'Support' },
  domain: 'demo.example',
  rootId: 'q',
  nodes: [{ id: 'q', kind: 'queue', label: 'Queue 9100' }],
  edges: [],
  notes: [],
};

const legacy = renderGalleryHtml('demo.example', [g]);
const themed = renderGalleryHtml('demo.example', [g], { theme: 'light' });

check('legacy gallery loads Mermaid', /<script src="[^"]*mermaid@[^"]*" integrity="sha384-/.test(legacy));
check('legacy gallery does not load Pele', !legacy.includes('pele'));
check('themed gallery loads pinned Pele with SRI', /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/pele@\d+\.\d+\.\d+\/dist\/pele\.global\.js" integrity="sha384-[^"]+" crossorigin="anonymous">/.test(themed));
check('themed gallery does not load Mermaid', !/<script[^>]*mermaid/i.test(themed));
check('themed gallery sanitizes renderer output (SVG XML parse + allowlist), never innerHTML', themed.includes("parseFromString(str, 'image/svg+xml')") && themed.includes('SAFE_EL') && !/\.innerHTML\s*=/.test(themed));
check('themed card shows the node count but no edge count', /class="cf-meta">1 nodes</.test(themed) && ![...themed.matchAll(/class="cf-meta">([^<]*)</g)].some((m) => /edge/.test(m[1])));
check('legacy card keeps nodes and edges', legacy.includes('1 nodes · 0 edges'));
check('themed gallery includes the PNG rasterizer', themed.includes('function svgToPngBlob('));
check('themed gallery has PNG, SVG and PDF controls', themed.includes("'Download PNG'") && themed.includes("'Download SVG'") && themed.includes("'Print or save as PDF (Letter)'"));

// Every inline script must at least parse. The scripts are JS inside a TS template literal, so a
// backslash lost in that layer (\\s → s) yields a broken regex that only a browser would report.
const inline = [...themed.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
check('themed gallery has inline scripts to check', inline.length >= 2);
inline.forEach((body, i) => check(`inline script ${i + 1} parses`, (() => { try { new Function(body); return true; } catch { return false; } })()));
check('sanitizer style filter is a working regex', /\/url\\s\*\\\(\|@import\|expression\\s\*\\\(\/i/.test(themed));

const own = renderGalleryHtml('demo.example', [g], { theme: 'light', peleSrc: 'https://static.example.com/pele.js' });
check('self-hosted peleSrc is used, without the CDN hash', own.includes('<script src="https://static.example.com/pele.js"></script>'));

// The domain is written into the inline script (export filenames, print header). A hostile value
// must stay a string literal: no raw `<` may reach the script body.
const hostile = renderGalleryHtml('x</script><script>alert(1)</script>', [g], { theme: 'light' });
const decl = /var CF_DOMAIN = ("(?:[^"\\]|\\.)*")/.exec(hostile);
check('domain lands in the script as a JSON string', !!decl && JSON.parse(decl[1]) === 'x</script><script>alert(1)</script>');
check('domain cannot close the script element', !!decl && !decl[1].includes('<'));

// The two exports a host uses to render Pele itself (the standalone viewer does).
check('peleScriptTag() is the pinned CDN build with SRI', /^<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/pele@\d+\.\d+\.\d+\/dist\/pele\.global\.js" integrity="sha384-[^"]+" crossorigin="anonymous"><\/script>$/.test(peleScriptTag()));
check('peleScriptTag() is the same tag the themed gallery loads', themed.includes(peleScriptTag()));
check('svgSanitizerScript() parses and defines cleanSvg', (() => { try { return new Function(svgSanitizerScript() + '\nreturn typeof cleanSvg === "function";')() === true; } catch { return false; } })());
check('the themed gallery injects that same sanitizer', themed.includes(svgSanitizerScript()));

check('letterPrintScript() parses and defines cfLetterPrint + cfBareClone', (() => { try { return new Function(letterPrintScript() + '\nreturn typeof cfLetterPrint === "function" && typeof cfBareClone === "function";')() === true; } catch { return false; } })());
check('the themed gallery injects that same print layout', themed.includes(letterPrintScript()) && themed.includes('cfLetterPrint('));

console.log(`\nhtml.selftest: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
