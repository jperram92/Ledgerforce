#!/usr/bin/env node
// Screenshots and checks the research prototypes in Docs/ui/research/directions/*.
//   node Docs/ui/research/tools/shot.mjs                 (every page)
//   node Docs/ui/research/tools/shot.mjs a-turns/home    (pages whose path contains the filter)
// Each page: 1440x900 full page (light), 390x844 full page, and 1440 dark when the page's
// <html> has data-dark="designed". PNGs are written next to the HTML as <page>-1440.png,
// <page>-390.png, <page>-1440-dark.png.
// Checks (any failure => exit 1): one <h1>, non-empty <title>, a <main>, html[lang="en-AU"],
// no console or page errors, no request outside the local server, no horizontal scroll at 390
// and 1440, text contrast >= 4.5:1 (3:1 large), axe-core WCAG 2.2 A/AA when AXE_PATH is set.
// Genericness probes (reported, scored by a human in 03-recommendation.md): main font families,
// box-shadow count, containers with radius > 8px, uppercase+tracked labels, middle-dot and arrow
// counts in visible text, purple/indigo colours in use.
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire('/home/user/Ledgerforce/package.json')('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = path.join(root, 'directions');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
const srv = http.createServer((q, r) => { const p = path.join(dirs, decodeURIComponent(q.url.split('?')[0])); if (!p.startsWith(dirs) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(r); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const origin = `http://127.0.0.1:${srv.address().port}`;
const axe = process.env.AXE_PATH && fs.existsSync(process.env.AXE_PATH) ? fs.readFileSync(process.env.AXE_PATH, 'utf8') : null;
const filters = process.argv.slice(2);
const pages = fs.readdirSync(dirs).flatMap((d) => fs.readdirSync(path.join(dirs, d)).filter((f) => f.endsWith('.html')).map((f) => `${d}/${f.replace(/\.html$/, '')}`))
  .filter((p) => !filters.length || filters.some((f) => p.includes(f))).sort();

function probe() {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const blend = (t, b) => ({ r: t.r * t.a + b.r * (1 - t.a), g: t.g * t.a + b.g * (1 - t.a), b: t.b * t.a + b.b * (1 - t.a), a: 1 });
  const bgOf = (el) => { const st = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { st.push(c); if (c.a >= 1) break; } } let b = parse(getComputedStyle(document.documentElement).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 }; if (b.a < 1) b = { r: 255, g: 255, b: 255, a: 1 }; for (let i = st.length - 1; i >= 0; i--) b = blend(st[i], b); return b; };
  const out = { fails: [], checked: 0, fonts: {}, shadows: 0, bigRadius: 0, caps: 0, dots: 0, arrows: 0, purple: 0 };
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) { const n = w.currentNode; const t = n.textContent.trim(); if (!t) continue; const el = n.parentElement; const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    if (cs.visibility === 'hidden' || cs.display === 'none' || r.width === 0 || el.closest('[aria-hidden="true"]') && !el.closest('svg')) continue;
    if (el.closest('.sr-only')) continue;
    out.checked++; const fam = cs.fontFamily.split(',')[0].replace(/"/g, ''); out.fonts[fam] = (out.fonts[fam] || 0) + t.length;
    if (cs.textTransform === 'uppercase' && parseFloat(cs.letterSpacing) > 0.5) out.caps++;
    out.dots += (t.match(/ · /g) || []).length; out.arrows += (t.match(/[→➔⟶]/g) || []).length;
    const fg = parse(cs.color); if (!fg) continue; let col = fg; const bg = bgOf(el); if (fg.a < 1) col = blend(fg, bg);
    const size = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight) >= 700; const large = size >= 24 || (bold && size >= 18.66);
    const k = ratio(col, bg); if (k < (large ? 3 : 4.5)) out.fails.push(`${k.toFixed(2)} "${t.slice(0, 40)}"`); }
  for (const el of document.querySelectorAll('body *')) { const cs = getComputedStyle(el); if (cs.boxShadow !== 'none' && !el.matches(':focus')) out.shadows++; const r = el.getBoundingClientRect(); if (r.width > 120 && r.height > 60 && parseFloat(cs.borderTopLeftRadius) > 8) out.bigRadius++;
    for (const p of [cs.color, cs.backgroundColor, cs.borderTopColor]) { const c = parse(p); if (!c || c.a === 0) continue; const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b); if (mx - mn < 40) continue; let h; const d = mx - mn; if (mx === c.r) h = ((c.g - c.b) / d) % 6; else if (mx === c.g) h = (c.b - c.r) / d + 2; else h = (c.r - c.g) / d + 4; h = (h * 60 + 360) % 360; if (h >= 240 && h <= 300) out.purple++; } }
  out.h1 = document.querySelectorAll('h1').length; out.title = document.title; out.main = !!document.querySelector('main'); out.lang = document.documentElement.lang;
  return out;
}

const b = await chromium.launch(); let failed = 0; const report = {};
for (const p of pages) {
  const dark = fs.readFileSync(path.join(dirs, p + '.html'), 'utf8').includes('data-dark="designed"');
  const modes = [['1440', 1440, 900, 'light'], ['390', 390, 844, 'light']]; if (dark) modes.push(['1440-dark', 1440, 900, 'dark']);
  report[p] = {};
  for (const [tag, w, h, scheme] of modes) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: 1 });
    const pg = await ctx.newPage(); const errs = [], ext = [];
    pg.on('console', (m) => m.type() === 'error' && errs.push(m.text())); pg.on('pageerror', (e) => errs.push(String(e)));
    pg.on('request', (r) => { if (!r.url().startsWith(origin) && !r.url().startsWith('data:')) ext.push(r.url()); });
    await pg.goto(`${origin}/${p}.html`); await pg.waitForLoadState('networkidle'); await pg.evaluate(() => document.fonts.ready);
    const sw = await pg.evaluate(() => document.documentElement.scrollWidth);
    const pr = await pg.evaluate(probe);
    let axeV = null; if (axe) { await pg.addScriptTag({ content: axe }); axeV = await pg.evaluate(async () => (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] })).violations.map((v) => `${v.id} (${v.nodes.length}) ${v.nodes[0]?.target}`)); }
    const file = path.join(dirs, `${p}-${tag}.png`); await pg.screenshot({ path: file, fullPage: true });
    const problems = [];
    if (pr.h1 !== 1) problems.push(`h1 count ${pr.h1}`); if (!pr.title.trim()) problems.push('no title'); if (!pr.main) problems.push('no main'); if (pr.lang !== 'en-AU') problems.push(`lang ${pr.lang}`);
    if (errs.length) problems.push('console: ' + errs.join(' | ')); if (ext.length) problems.push('external: ' + ext.join(' '));
    if (sw > w) problems.push(`horizontal scroll ${sw}>${w}`); if (pr.fails.length) problems.push(`contrast x${pr.fails.length}: ${pr.fails.slice(0, 4).join('; ')}`);
    if (axeV && axeV.length) problems.push('axe: ' + axeV.join('; '));
    report[p][tag] = { problems, fonts: pr.fonts, shadows: pr.shadows, bigRadius: pr.bigRadius, capsLabels: pr.caps, middleDots: pr.dots, arrows: pr.arrows, purpleColours: pr.purple, textNodes: pr.checked };
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${p} ${tag}  ${problems.join(' || ')}`);
    console.log(`      fonts ${Object.entries(pr.fonts).sort((a, c) => c[1] - a[1]).map(([f, n]) => `${f}:${n}`).slice(0, 3).join(' ')} shadows ${pr.shadows} radius>8 ${pr.bigRadius} caps ${pr.caps} dots ${pr.dots} arrows ${pr.arrows} purple ${pr.purple}`);
    if (problems.length) failed++; await ctx.close();
  }
}
fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });
if (!filters.length) fs.writeFileSync(path.join(root, 'evidence', 'check-report.json'), JSON.stringify(report, null, 2));
await b.close(); srv.close(); process.exit(failed ? 1 : 0);
