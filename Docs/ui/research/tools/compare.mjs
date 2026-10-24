// Builds evidence/side-by-side.png and evidence/silhouette.png: the two rejected looks next to
// the three research directions, cropped to the first 1440x900 screen. The silhouette version
// blurs and greys every image (genericness check G13: could the outline be any SaaS?).
import { createRequire } from 'node:module'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const { chromium } = createRequire('/home/user/Ledgerforce/package.json')('playwright');
const ui = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const items = [['Rejected v0.1', 'screenshots/01-home-dashboard.png'], ['Rejected v2 Columnar', 'v2/screenshots/03-invoice-detail-desk.png'],
  ['A Turns', 'research/directions/a-turns/home-1440.png'], ['B Flows', 'research/directions/b-flows/home-1440.png'], ['C Timeline', 'research/directions/c-timeline/home-1440.png']];
const img = (p) => 'data:image/png;base64,' + fs.readFileSync(path.join(ui, p)).toString('base64');
const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1500, height: 900 } });
for (const [name, filter] of [['side-by-side', 'none'], ['silhouette', 'grayscale(1) blur(2px)']]) {
  await pg.setContent(`<body style="margin:0;padding:16px;background:#fff;font:600 15px sans-serif;display:grid;grid-template-columns:repeat(3,1fr);gap:12px">${items.map(([t, p]) => `<figure style="margin:0"><figcaption style="margin-bottom:6px">${t}</figcaption><div style="aspect-ratio:1440/900;overflow:hidden;border:1px solid #999"><img src="${img(p)}" style="width:100%;filter:${filter}"></div></figure>`).join('')}</body>`);
  await pg.screenshot({ path: path.join(ui, 'research/evidence', name + '.png'), fullPage: true });
}
await b.close();
