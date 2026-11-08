/**
 * Genericness probes of Docs/ui/research/tools/shot.mjs (RQ-0084, DL-0065) as one self-contained
 * page function, for specs that test apps/web (T-0081). Identical checks to the copy inside
 * tests/e2e/ui-system.spec.ts (T-0106), which is left untouched here; a later task may make that
 * spec import this file instead.
 */
export interface Probe {
  shadows: string[];
  bigRadius: string[];
  caps: string[];
  purple: string[];
  dots: number;
  arrows: number;
}

/** Runs in the page: `await page.evaluate(genericnessProbe)`. */
export function genericnessProbe(): Probe {
  const parse = (c: string) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m?.[1]) return null;
    const p = m[1]
      .split(/[ ,/]+/)
      .filter(Boolean)
      .map((x) => Number.parseFloat(x));
    return { r: p[0] ?? 0, g: p[1] ?? 0, b: p[2] ?? 0, a: p.length > 3 ? (p[3] ?? 1) : 1 };
  };
  const name = (el: Element) =>
    `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${[...el.classList].join('.')}`;
  const out: Probe = { shadows: [], bigRadius: [], caps: [], purple: [], dots: 0, arrows: 0 };
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    if (cs.boxShadow !== 'none') out.shadows.push(name(el));
    const r = el.getBoundingClientRect();
    if (r.width > 120 && r.height > 60 && Number.parseFloat(cs.borderTopLeftRadius) > 8) {
      out.bigRadius.push(name(el));
    }
    if (cs.textTransform === 'uppercase' && Number.parseFloat(cs.letterSpacing) > 0.5) {
      out.caps.push(name(el));
    }
    for (const prop of [cs.color, cs.backgroundColor, cs.borderTopColor, cs.fill, cs.stroke]) {
      const c = parse(prop);
      if (!c || c.a === 0) continue;
      const mx = Math.max(c.r, c.g, c.b);
      const mn = Math.min(c.r, c.g, c.b);
      if (mx - mn < 40) continue;
      const d = mx - mn;
      let h: number;
      if (mx === c.r) h = ((c.g - c.b) / d) % 6;
      else if (mx === c.g) h = (c.b - c.r) / d + 2;
      else h = (c.r - c.g) / d + 4;
      h = (h * 60 + 360) % 360;
      if (h >= 240 && h <= 300) out.purple.push(name(el));
    }
  }
  const text = document.body.innerText;
  out.dots = (text.match(/ · /g) ?? []).length;
  out.arrows = (text.match(/[→➔⟶]/g) ?? []).length;
  return out;
}
