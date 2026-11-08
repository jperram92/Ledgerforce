import { createRequire } from 'node:module'; const { chromium } = createRequire(new URL('../../../../package.json', import.meta.url))('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = new URL('..', import.meta.url).pathname;
const types = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.woff2':'font/woff2', '.png':'image/png' };
const srv = http.createServer((q, r) => { const p = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (!fs.existsSync(p)) { r.writeHead(404); return r.end(); } r.writeHead(200, {'content-type': types[path.extname(p)]||'application/octet-stream'}); fs.createReadStream(p).pipe(r); });
await new Promise(r => srv.listen(0, r)); const port = srv.address().port;
const [, , page, ...modes] = process.argv;
const b = await chromium.launch(); const out = process.env.OUT || new URL('../screenshots', import.meta.url).pathname;
fs.mkdirSync(out, { recursive: true });
for (const m of (modes.length ? modes : ['desk'])) {
  const w = m.startsWith('phone') ? 390 : 1440; const ctx = await b.newContext({ viewport: { width: w, height: m.startsWith('phone') ? 844 : 900 }, deviceScaleFactor: 1, colorScheme: m.endsWith('dark') ? 'dark' : 'light' });
  const pg = await ctx.newPage(); const errs = []; pg.on('console', c => c.type()==='error' && errs.push(c.text())); pg.on('pageerror', e => errs.push(String(e)));
  await pg.goto(`http://127.0.0.1:${port}/mockups/${page}.html`); await pg.waitForLoadState('networkidle'); await pg.evaluate(() => document.fonts.ready);
  const sw = await pg.evaluate(() => document.documentElement.scrollWidth);
  const f = `${out}/${page}-${m}.png`; await pg.screenshot({ path: f, fullPage: true }); console.log(f, 'scrollWidth', sw, errs.length ? 'ERRORS ' + errs.join(' | ') : '');
  await ctx.close();
}
await b.close(); srv.close();
