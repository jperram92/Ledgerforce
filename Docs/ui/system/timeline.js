// Direction C timeline renderer. One date axis for every lane. Settled = solid, expected =
// dashed or hollow, today = teal. Bank balance is a step line (a balance changes on a date, it
// does not glide between dates). On narrow screens only the cash lane is drawn; the agenda
// below the chart carries the lanes.
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (n, a, t) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); if (t != null) e.textContent = t; return e; };
  const fmt = (v) => v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const D = (s) => new Date(s + 'T12:00:00');
  const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function draw(box, spec) {
    const narrow = box.clientWidth < 700;
    const W = box.clientWidth, LW = narrow ? 0 : 150, R = narrow ? 34 : 48;
    const from = D(narrow ? spec.narrowFrom : spec.from), to = D(spec.to), today = D(spec.today);
    const days = (to - from) / 864e5;
    const x = (s) => LW + 8 + ((D(s) - from) / 864e5 / days) * (W - LW - 8 - R);
    const CASH_TOP = 44, CASH_H = narrow ? 150 : 190, LANE = 70;
    const lanes = narrow ? [] : spec.lanes;
    const Hh = CASH_TOP + CASH_H + 26 + lanes.length * LANE + 34;
    const fixes = []; const svg = el('svg', { class: 'tl', viewBox: `0 0 ${W} ${Hh}`, width: W, height: Hh, role: 'img', 'aria-label': spec.summary });
    // axis
    for (let t = new Date(from); t <= to; t = new Date(+t + 864e5)) {
      const s = t.toISOString().slice(0, 10), xx = x(s);
      if (t.getDay() === 1 || (+t === +from && ![0, 6].includes(t.getDay()) && t.getDay() !== 1)) {
        const nearEnd = (to - t) / 864e5 < 2; if (narrow && nearEnd) continue;
        svg.appendChild(el('line', { x1: xx, x2: xx, y1: 26, y2: Hh, stroke: 'var(--line)', 'stroke-width': 1 }));
        svg.appendChild(el('text', { x: nearEnd ? xx - 3 : xx + 3, y: 20, class: 'day', 'text-anchor': nearEnd ? 'end' : 'start' }, `${dayName[t.getDay()]} ${t.getDate()}${!narrow && (t.getDate() <= 7 || +t === +from) ? ' ' + t.toLocaleString('en-AU', { month: 'short' }) : ''}`));
      }
    }
    // lanes background and names
    lanes.forEach((ln, i) => { const y = CASH_TOP + CASH_H + 26 + i * LANE;
      if (i % 2 === 0) svg.insertBefore(el('rect', { x: 0, y, width: W, height: LANE, fill: 'var(--lane)' }), svg.firstChild);
      svg.appendChild(el('text', { x: 0, y: y + 22, class: 'lane-name' }, ln.name));
      if (ln.sub) svg.appendChild(el('text', { x: 0, y: y + 40, class: 'lab-2' }, ln.sub)); });
    // cash
    const [lo, hi] = spec.cashRange; const yv = (v) => CASH_TOP + CASH_H - ((v - lo) / (hi - lo)) * CASH_H;
    if (!narrow) { svg.appendChild(el('text', { x: 0, y: CASH_TOP + 14, class: 'lane-name' }, 'Cash in bank'));
      svg.appendChild(el('text', { x: 0, y: CASH_TOP + 32, class: 'lab-2' }, 'both accounts')); }
    for (const g of spec.cashGrid) { if (narrow && g !== spec.cashGrid[0] && g !== spec.cashGrid.at(-1)) continue;
      svg.appendChild(el('line', { x1: LW + 8, x2: W - R, y1: yv(g), y2: yv(g), stroke: 'var(--line)', 'stroke-dasharray': '2 3' }));
      svg.appendChild(el('text', { x: W - 2, y: yv(g) + 4, 'text-anchor': 'end', class: 'day' }, `${g / 1000}k`)); }
    const pts = spec.cash.filter((p) => D(p[0]) >= from || p === spec.cash.find((q) => D(q[0]) >= from));
    const first = spec.cash.filter((p) => D(p[0]) <= from).at(-1) || spec.cash[0];
    const path = (arr, startV) => { let d = `M${x(arr[0][0] < (narrow ? spec.narrowFrom : spec.from) ? (narrow ? spec.narrowFrom : spec.from) : arr[0][0])},${yv(startV)}`; let v = startV;
      for (const [s, nv] of arr) { const xx = Math.max(x(s), LW + 8); d += ` H${xx} V${yv(nv)}`; v = nv; } return d; };
    const past = spec.cash.filter((p) => D(p[0]) <= today && D(p[0]) > from), fut = spec.cash.filter((p) => D(p[0]) > today);
    const lastPast = spec.cash.filter((p) => D(p[0]) <= today).at(-1);
    svg.appendChild(el('path', { d: path([[narrow ? spec.narrowFrom : spec.from, first[1]], ...past, [spec.today, lastPast[1]]], first[1]), fill: 'none', stroke: 'var(--ink)', 'stroke-width': 2.5 }));
    svg.appendChild(el('path', { d: path([[spec.today, lastPast[1]], ...fut, [spec.to, fut.at(-1)[1]]], lastPast[1]), fill: 'none', stroke: 'var(--ink)', 'stroke-width': 2, 'stroke-dasharray': '6 4' }));
    for (const c of spec.cashCallouts) { if (narrow && !c.narrow) continue; const cx = x(c.date), cy = yv(c.value);
      svg.appendChild(el('rect', { x: cx - 4, y: cy - 4, width: 8, height: 8, fill: c.future ? 'var(--paper)' : 'var(--ink)', stroke: 'var(--ink)', 'stroke-width': 2 }));
      const anchor = c.anchor || 'start'; const dx = anchor === 'end' ? -8 : 8;
      svg.appendChild(el('text', { x: cx + dx, y: cy + (c.dy || -12), 'text-anchor': anchor, class: 'amt' }, fmt(c.value)));
      if (c.note) svg.appendChild(el('text', { x: cx + dx, y: cy + (c.dy || -12) + 16, 'text-anchor': anchor, class: 'lab-2' }, c.note)); }
    // lane items
    lanes.forEach((ln, i) => { const y = CASH_TOP + CASH_H + 26 + i * LANE;
      for (const it of ln.items) {
        if (it.span) { const x1 = x(it.span[0]), x2 = x(it.span[1]);
          const pid = 'hatch'; if (!svg.querySelector('#hatch')) { const defs = el('defs'); const p = el('pattern', { id: pid, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }); p.appendChild(el('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'var(--ink-2)', 'stroke-width': 1.5 })); defs.appendChild(p); svg.insertBefore(defs, svg.firstChild); }
          svg.appendChild(el('rect', { x: x1, y: y + 8, width: x2 - x1, height: LANE - 12, fill: 'url(#hatch)', stroke: 'var(--ink)', 'stroke-width': 1 }));
          const t = el('text', { x: x1 + 10, y: y + 30, class: 'amt' }, it.label); const st = el('text', { x: x1 + 10, y: y + 47, class: 'lab-2' }, it.sub);
          const bg = el('rect', { x: x1 + 4, y: y + 14, height: 40, width: 10, fill: 'var(--paper)' }); svg.appendChild(bg); svg.appendChild(t); svg.appendChild(st);
          fixes.push(() => bg.setAttribute('width', Math.max(t.getComputedTextLength(), st.getComputedTextLength()) + 14));
          continue; }
        const xx = x(it.date), lv = it.level || 0, col = it.now ? 'var(--now)' : 'var(--ink)', my = y + (lv ? 44 : 10);
        if (it.tick) { svg.appendChild(el('rect', { x: xx - 2, y: y + LANE - 8 - it.tick, width: 4, height: it.tick, fill: it.now ? 'var(--now)' : 'var(--line-2)' })); continue; }
        svg.appendChild(el('rect', it.future ? { x: xx - 5, y: my, width: 10, height: 10, fill: 'var(--paper)', stroke: col, 'stroke-width': 2, 'stroke-dasharray': it.now ? '' : '2 1.5' } : { x: xx - 5, y: my, width: 10, height: 10, fill: col }));
        if (it.label) { const anchor = it.anchor || 'start', dx = anchor === 'end' ? -10 : 10;
          const tt = el('text', { x: xx + dx, y: my + 9, 'text-anchor': anchor, class: it.now ? 'amt now-t' : 'amt' }); tt.appendChild(document.createTextNode(it.label));
          if (it.sub && lv) tt.appendChild(el('tspan', { class: 'lab-2', dx: 6, style: 'font-weight:400' }, it.sub));
          svg.appendChild(tt);
          if (it.sub && !lv) svg.appendChild(el('text', { x: xx + dx, y: my + 25, 'text-anchor': anchor, class: 'lab-2' }, it.sub)); }
      } });
    // today
    const tx = x(spec.today);
    svg.appendChild(el('line', { x1: tx, x2: tx, y1: 26, y2: Hh, stroke: 'var(--now)', 'stroke-width': 3 }));
    const tw = narrow ? 92 : 116; svg.appendChild(el('rect', { x: tx - 1.5, y: Hh - 26, width: tw, height: 26, fill: 'var(--now)' }));
    svg.appendChild(el('text', { x: tx + 6, y: Hh - 8, style: 'fill:var(--paper);font-weight:800' }, narrow ? 'Today, Sat 24' : 'Today, Sat 24 Oct'));
    box.replaceChildren(svg); fixes.forEach((f) => f());
  }
  function all() { document.querySelectorAll('[data-timeline]').forEach((b) => draw(b, JSON.parse(document.getElementById(b.dataset.timeline).textContent))); }
  all(); let t; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(all, 100); });
})();
