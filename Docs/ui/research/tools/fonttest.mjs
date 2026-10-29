import { createRequire } from 'node:module'; import fs from 'node:fs'; import path from 'node:path';
const { chromium } = createRequire('/home/user/Ledgerforce/package.json')('playwright');
const base = process.argv[2]; const fams = fs.readdirSync(base);
let css = '', rows = [];
for (const d of fams) { const fdir = path.join(base, d, 'package/files'); if (!fs.existsSync(fdir)) continue;
  const f = fs.readdirSync(fdir).find(n => /latin-400-normal\.woff2$/.test(n) && !/latin-ext/.test(n)); if (!f) continue;
  const b64 = fs.readFileSync(path.join(fdir, f)).toString('base64'); const name = d.replace(/^fontsource-|-[\d.]+$/g,'');
  css += `@font-face{font-family:"${name}";src:url(data:font/woff2;base64,${b64})}`; rows.push(name); }
const b = await chromium.launch(); const p = await b.newPage();
await p.setContent(`<style>${css}</style>` + rows.map(r=>`<span style="font-family:'${r}'">x</span>`).join(''));
await p.evaluate(() => document.fonts.ready);
const res = await p.evaluate((rows) => rows.map(r => {
  const m = (txt, feat) => { const s = document.createElement('span'); s.style.cssText = `font-family:'${r}';font-size:100px;white-space:pre;position:absolute;font-feature-settings:${feat}`; s.textContent = txt; document.body.appendChild(s); const w = s.getBoundingClientRect().width; s.remove(); return Math.round(w); };
  const c = (feat) => { const cv = document.createElement('canvas'); cv.width=200; cv.height=150; const x = cv.getContext('2d'); x.font = `100px '${r}'`; x.fontKerning='none'; if (feat) x.canvas.style.fontFeatureSettings=feat; x.fillText('0',10,110); return cv.toDataURL().length; };
  const dflt1 = m('1111111111','normal'), dflt0 = m('0000000000','normal');
  const tn1 = m('1111111111','"tnum"'), tn0 = m('0000000000','"tnum"');
  const z0 = m('0','normal'); 
  return { font: r, defaultTabular: dflt1===dflt0, tnumTabular: tn1===tn0, w1: dflt1, w0: dflt0, tn1, tn0 };
}), rows);
// slashed zero check via element screenshots
for (const r of res) { 
  const a = await p.evaluate((f)=>{document.body.innerHTML=`<div id=a style="font-family:'${f}';font-size:80px;display:inline-block">0O1lI</div><div id=b style="font-family:'${f}';font-size:80px;display:inline-block;font-feature-settings:'zero'">0O1lI</div>`; return 1}, r.font);
  const ia = await p.locator('#a').screenshot(); const ib = await p.locator('#b').screenshot(); r.zeroFeature = Buffer.compare(ia, ib) !== 0;
  await p.locator('#a').screenshot({ path: process.argv[3] + '/' + r.font + '.png' });
}
console.table(res.map(r=>({font:r.font, tabularByDefault:r.defaultTabular, tnumWorks:r.tnumTabular, zeroFeature:r.zeroFeature})));
await b.close();
