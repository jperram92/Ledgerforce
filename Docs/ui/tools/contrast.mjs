#!/usr/bin/env node
// Verifies WCAG 2.2 AA contrast for every documented token pair in Docs/ui/tokens.css,
// for both the light theme (:root) and the dark theme (:root[data-theme="dark"]).
// Usage: node Docs/ui/tools/contrast.mjs [--md]
// Exit code 1 if any pair is below its threshold. Zero dependencies.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function block(selectorRegex) {
  const m = css.match(selectorRegex);
  if (!m) throw new Error(`block not found: ${selectorRegex}`);
  const vars = {};
  for (const d of m[1].matchAll(/(--lf-[\w-]+)\s*:\s*([^;]+);/g)) vars[d[1]] = d[2].trim();
  return vars;
}
const light = block(/^:root\s*\{([\s\S]*?)\n\}/m);
const dark = { ...light, ...block(/^:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/m) };

function resolve(vars, name, depth = 0) {
  const v = vars[name];
  if (v === undefined) throw new Error(`undefined token ${name}`);
  const ref = v.match(/^var\((--lf-[\w-]+)\)$/);
  if (ref && depth < 5) return resolve(vars, ref[1], depth + 1);
  return v;
}
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}
export function luminance([r, g, b]) {
  const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
export function ratio(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

// [foreground, background, minimum, purpose]
const T = 4.5, N = 3;
const pairs = [
  ['text', 'surface', T, 'Body text on card'],
  ['text', 'bg', T, 'Body text on canvas'],
  ['text-muted', 'surface', T, 'Labels on card'],
  ['text-muted', 'surface-2', T, 'Table header text'],
  ['text-muted', 'surface-hover', T, 'Muted text on hovered row'],
  ['text-subtle', 'surface', T, 'Captions on card'],
  ['text-subtle', 'bg', T, 'Captions on canvas'],
  ['text-subtle', 'surface-2', T, 'Captions in sunken well'],
  ['text', 'surface-selected', T, 'Text on selected row'],
  ['accent-text', 'surface', T, 'Links on card'],
  ['accent-text', 'accent-soft', T, 'Accent text on tint'],
  ['accent-fg', 'accent', T, 'Primary button label'],
  ['accent-fg', 'accent-hover', T, 'Primary button label (hover)'],
  ['text-inverse', 'danger-solid', T, 'Destructive button label'],
  ['text-inverse', 'success-solid', T, 'Success button label'],
  ['nav-fg', 'nav-bg', T, 'Navigation item'],
  ['nav-active-fg', 'nav-active-bg', T, 'Navigation item (active)'],
  ['success-fg', 'success-bg', T, 'Success banner text'],
  ['warning-fg', 'warning-bg', T, 'Warning banner text'],
  ['danger-fg', 'danger-bg', T, 'Danger banner text'],
  ['info-fg', 'info-bg', T, 'Info banner text'],
  ['success-fg', 'surface', T, 'Success text on card'],
  ['warning-fg', 'surface', T, 'Warning text on card'],
  ['danger-fg', 'surface', T, 'Danger text on card'],
  ['info-fg', 'surface', T, 'Info text on card'],
  ...['draft', 'awaiting', 'approved', 'posted', 'partpaid', 'paid', 'overdue', 'void', 'reversed', 'locked']
    .map((s) => [`status-${s}-fg`, `status-${s}-bg`, T, `Status chip: ${s}`]),
  ['border-strong', 'surface', N, 'Input border (1.4.11)'],
  ['border-strong', 'bg', N, 'Input border on canvas (1.4.11)'],
  ['focus', 'surface', N, 'Focus ring on card (2.4.11/1.4.11)'],
  ['focus', 'bg', N, 'Focus ring on canvas'],
  ['status-void-border', 'surface', N, 'Void chip dashed border'],
  ['warning-solid', 'surface', N, 'Warning icon/dot'],
  ['danger-solid', 'surface', N, 'Danger icon/dot'],
  ['success-solid', 'surface', N, 'Success icon/dot'],
  ['info-solid', 'surface', N, 'Info icon/dot'],
  ['accent', 'surface', N, 'Accent icon / selected checkbox'],
];

const rows = [];
let failures = 0;
for (const [fg, bg, min, purpose] of pairs) {
  for (const [theme, vars] of [['light', light], ['dark', dark]]) {
    const f = resolve(vars, `--lf-${fg}`), b = resolve(vars, `--lf-${bg}`);
    const r = ratio(hexToRgb(f), hexToRgb(b));
    const ok = r >= min;
    if (!ok) failures++;
    rows.push({ theme, fg, bg, f, b, r, min, ok, purpose });
  }
}

if (process.argv.includes('--md')) {
  console.log('| Pair (fg on bg) | Purpose | Min | Light | Dark |');
  console.log('|---|---|---|---|---|');
  for (let i = 0; i < rows.length; i += 2) {
    const l = rows[i], d = rows[i + 1];
    const cell = (x) => `${x.r.toFixed(2)}:1 ${x.ok ? 'pass' : '**FAIL**'} (${x.f} / ${x.b})`;
    console.log(`| \`${l.fg}\` on \`${l.bg}\` | ${l.purpose} | ${l.min}:1 | ${cell(l)} | ${cell(d)} |`);
  }
} else {
  for (const x of rows) console.log(`${x.ok ? 'ok  ' : 'FAIL'} ${x.theme.padEnd(5)} ${x.r.toFixed(2).padStart(5)}:1 (min ${x.min}) ${x.fg} on ${x.bg}  [${x.f} on ${x.b}]`);
}
const min = rows.reduce((m, x) => (x.min === T && x.r < m.r ? x : m), { r: 99 });
console.error(`\n${rows.length} checks, ${failures} failures. Lowest text pair: ${min.r.toFixed(2)}:1 (${min.theme} ${min.fg} on ${min.bg}).`);
process.exit(failures ? 1 : 0);
