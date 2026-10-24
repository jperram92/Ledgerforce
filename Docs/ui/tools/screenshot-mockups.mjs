#!/usr/bin/env node
// Screenshots every mockup in Docs/ui/mockups and runs automated checks.
//   node Docs/ui/tools/screenshot-mockups.mjs            (all pages)
//   node Docs/ui/tools/screenshot-mockups.mjs 03 05      (only names containing "03" or "05")
// Checks per page (any failure => exit 1):
//   - no console errors, no page errors, no network request outside the local static server (no external resources)
//   - exactly one <h1>, a non-empty <title>, a <main> landmark, html[lang]
//   - body text colour vs body background >= 4.5:1, and every visible text node vs its
//     nearest opaque background >= 4.5:1 (>= 3:1 for large text) — WCAG 1.4.3
//   - optional: axe-core WCAG 2 A/AA rules when AXE_PATH points at axe.min.js (or `axe-core` resolves)
// Playwright is resolved from the global install (`require('playwright')`); no project dependency.
import { createRequire } from 'node:module';
import { readdirSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  const g = require('node:child_process').execSync('npm root -g').toString().trim();
  ({ chromium } = require(join(g, 'playwright')));
}

const here = dirname(fileURLToPath(import.meta.url));
const uiDir = resolve(here, '..');
const mockDir = join(uiDir, 'mockups');
const outDir = join(uiDir, 'screenshots');
mkdirSync(outDir, { recursive: true });

let axeSource = null;
const axePath = process.env.AXE_PATH || (() => { try { return require.resolve('axe-core/axe.min.js'); } catch { return null; } })();
if (axePath && existsSync(axePath)) axeSource = readFileSync(axePath, 'utf8');

const MOBILE = new Set(['12-mobile-approvals', 'index']);
const DARK = new Set(['01-home-dashboard', '03-invoice-detail', '06-bank-reconciliation']);
const filters = process.argv.slice(2);
const pages = readdirSync(mockDir).filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, ''))
  .filter((n) => !filters.length || filters.some((x) => n.includes(x))).sort();

// Runs in the page: contrast of every visible text node against its nearest opaque background.
function auditContrast() {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const blend = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  function bgOf(el) {
    const stack = [];
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) base = blend(stack[i], base);
    return base;
  }
  const bodyFg = parse(getComputedStyle(document.body).color);
  const bodyBg = bgOf(document.body);
  const results = { body: ratio(bodyFg, bodyBg), checked: 0, min: 99, minAt: '', failures: [] };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode()) {
    const t = walker.currentNode; const el = t.parentElement;
    if (!el || seen.has(el) || !t.textContent.trim()) continue;
    seen.add(el);
    if (el.closest('script,style,.sr-only,.skip,[aria-hidden="true"],[disabled],[aria-disabled="true"],.mock-only')) continue;
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    if (cs.visibility === 'hidden' || cs.display === 'none' || r.width === 0 || r.height === 0) continue;
    let op = 1; for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
    if (op < 1) continue; // dimmed decorative/disabled content is exempt (WCAG 1.4.3 inactive components)
    const fg = parse(cs.color); if (!fg) continue;
    const bg = bgOf(el);
    const cr = ratio(fg.a < 1 ? blend(fg, bg) : fg, bg);
    const size = parseFloat(cs.fontSize); const bold = Number(cs.fontWeight) >= 700;
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    results.checked++;
    const label = `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${t.textContent.trim().slice(0, 40)}"`;
    if (cr < results.min) { results.min = cr; results.minAt = label; }
    if (cr < need) results.failures.push({ el: label, ratio: Number(cr.toFixed(2)), need });
  }
  return results;
}

// Serve Docs/ui over loopback HTTP (file:// blocks stylesheet reads by axe and is not how the app runs).
const http = await import('node:http');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const p = resolve(uiDir, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(uiDir) || !existsSync(p)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream' });
  res.end(readFileSync(p));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const report = { generated: new Date().toISOString(), axe: Boolean(axeSource), pages: [] };
let failed = 0;

for (const name of pages) {
  const variants = [{ suffix: '', query: '' }];
  if (DARK.has(name)) variants.push({ suffix: '-dark', query: '?theme=dark' });
  for (const v of variants) {
    const vp = MOBILE.has(name) ? { width: 390, height: 844 } : { width: 1440, height: 900 };
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: MOBILE.has(name) ? 2 : 1, colorScheme: 'light' });
    const page = await ctx.newPage();
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('request', (r) => { if (!r.url().startsWith(origin) && !r.url().startsWith('data:')) problems.push(`external request: ${r.url()}`); });
    await page.goto(`${origin}/mockups/${name}.html${v.query}`, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const meta = await page.evaluate(() => ({
      title: document.title.trim(), h1: document.querySelectorAll('h1').length,
      main: document.querySelectorAll('main').length, lang: document.documentElement.lang,
      hOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    }));
    if (!meta.title) problems.push('missing <title>');
    if (meta.h1 !== 1) problems.push(`expected exactly one <h1>, found ${meta.h1}`);
    if (meta.main < 1) problems.push('missing <main> landmark');
    if (!meta.lang) problems.push('missing html[lang]');
    if (meta.hOverflow) problems.push('horizontal page overflow');
    const contrast = await page.evaluate(auditContrast);
    if (contrast.body < 4.5) problems.push(`body text contrast ${contrast.body.toFixed(2)}:1 < 4.5`);
    for (const f of contrast.failures) problems.push(`contrast ${f.ratio}:1 < ${f.need} at ${f.el}`);
    let axe = null;
    if (axeSource) {
      await page.addScriptTag({ content: axeSource });
      axe = await page.evaluate(async () => {
        const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
        return r.violations.map((x) => ({ id: x.id, impact: x.impact, nodes: x.nodes.length, sample: x.nodes[0]?.target?.join(' ') }));
      });
      for (const x of axe) problems.push(`axe ${x.id} (${x.impact}) x${x.nodes}: ${x.sample}`);
    }
    const file = `${name}${v.suffix}.png`;
    await page.screenshot({ path: join(outDir, file), fullPage: true });
    await ctx.close();
    const entry = { page: name + v.suffix, viewport: `${vp.width}x${vp.height}`, screenshot: `screenshots/${file}`, title: meta.title,
      bodyContrast: Number(contrast.body.toFixed(2)), minTextContrast: Number(contrast.min.toFixed(2)), minTextAt: contrast.minAt,
      textNodesChecked: contrast.checked, axeViolations: axe ? axe.length : 'not run', problems };
    report.pages.push(entry);
    if (problems.length) failed++;
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${entry.page.padEnd(34)} body ${entry.bodyContrast}:1  min text ${entry.minTextContrast}:1 (${contrast.checked} nodes)  axe ${entry.axeViolations}`);
    for (const p of problems) console.log(`       - ${p}`);
  }
}
await browser.close();
server.close();
if (!filters.length) writeFileSync(join(outDir, 'check-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.pages.length} screenshots, ${failed} with problems${axeSource ? '' : ' (axe-core not found: set AXE_PATH to run it)'}.`);
process.exit(failed ? 1 : 0);
