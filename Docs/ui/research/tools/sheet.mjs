import { createRequire } from 'node:module'; import fs from 'node:fs'; import path from 'node:path';
const { chromium } = createRequire('/home/user/Ledgerforce/package.json')('playwright');
const base = process.argv[2]; const want = ['atkinson-hyperlegible-next','atkinson-hyperlegible-mono','b612','b612-mono','source-sans-3','source-serif-4','public-sans','newsreader','overpass','hanken-grotesk','red-hat-text','literata','schibsted-grotesk','instrument-sans'];
let css='', html='';
for (const d of fs.readdirSync(base)) { const name = d.replace(/^fontsource-|-[\d.]+$/g,''); if(!want.includes(name)) continue; const fdir = path.join(base,d,'package/files');
 for (const w of [400,600,700]) { const f = `${name}-latin-${w}-normal.woff2`; if (!fs.existsSync(path.join(fdir,f))) continue; css += `@font-face{font-family:"${name}";font-weight:${w};src:url(data:font/woff2;base64,${fs.readFileSync(path.join(fdir,f)).toString('base64')})}`; }
 html += `<div style="font-family:'${name}';font-size:22px;margin:6px 0;font-variant-numeric:tabular-nums"><b style="display:inline-block;width:300px;font:13px sans-serif">${name}</b>Il1 O0 $10,059.50 (914.50) 8,316.80 <span style="font-weight:600">Approve $3,190.00</span> Harbour &amp; Co</div>`; }
const b = await chromium.launch(); const p = await b.newPage({viewport:{width:1100,height:700}});
await p.setContent(`<style>${css}body{margin:16px}</style>${html}`); await p.evaluate(()=>document.fonts.ready);
await p.screenshot({path: process.argv[3], fullPage:true}); await b.close();
