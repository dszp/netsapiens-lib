/**
 * Gallery HTML: which renderer each path loads, and that host-supplied strings cannot break out of
 * the inline script. The drawing, PNG and print paths are browser-only (validated in a browser).
 * Run: `pnpm test:html`.
 */
import { renderGalleryHtml } from './html.js';
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
check('themed gallery includes the PNG rasterizer', themed.includes('function svgToPngBlob('));
check('themed gallery has PNG, SVG and PDF controls', themed.includes("'Download PNG'") && themed.includes("'Download SVG'") && themed.includes("'Print or save as PDF (Letter)'"));

const own = renderGalleryHtml('demo.example', [g], { theme: 'light', peleSrc: 'https://static.example.com/pele.js' });
check('self-hosted peleSrc is used, without the CDN hash', own.includes('<script src="https://static.example.com/pele.js"></script>'));

// The domain is written into the inline script (export filenames, print header). A hostile value
// must stay a string literal: no raw `<` may reach the script body.
const hostile = renderGalleryHtml('x</script><script>alert(1)</script>', [g], { theme: 'light' });
const decl = /var CF_DOMAIN = ("(?:[^"\\]|\\.)*")/.exec(hostile);
check('domain lands in the script as a JSON string', !!decl && JSON.parse(decl[1]) === 'x</script><script>alert(1)</script>');
check('domain cannot close the script element', !!decl && !decl[1].includes('<'));

console.log(`\nhtml.selftest: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
