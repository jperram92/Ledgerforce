// Direction B flow renderer. Draws money moving between named places, with band thickness in
// proportion to the amount. Data comes from the posting engine (here: inline JSON in the page).
// Wide containers get a left-to-right diagram; narrow ones (phones) get the same flows as ranked
// rows, because a diagram with five labelled destinations cannot be read at 358px.
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const fmt = (v) => v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const el = (n, a, t) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); if (t != null) e.textContent = t; return e; };
  const colour = { in: 'var(--in-band)', out: 'var(--out-band)', bank: 'var(--bank)' };
  const sum = (ns) => ns.reduce((s, n) => s + n.value, 0);

  function wide(box, spec) {
    const W = box.clientWidth, LW = spec.leftLabel || 270, RW = spec.rightLabel || 270, BW = 14, SLOT = 48, H = spec.height || 300;
    const cols = spec.cols; const maxTot = Math.max(...cols.map(sum));
    const scale = H / maxTot;
    const xs = cols.map((_, i) => LW + (W - LW - RW - BW) * (cols.length === 1 ? 0 : i / (cols.length - 1)));
    const layout = cols.map((ns, i) => {
      if (ns.length === 1) { const n = ns[0]; const h = Math.max(n.hIn || 0, n.hOut || 0, n.value) * scale; return [{ n, x: xs[i], y: 60, h }]; }
      let y = 60; const totalSlots = ns.reduce((s, n) => s + Math.max(n.value * scale, SLOT - 10) + 10, 0);
      const colH = Math.max(H, totalSlots); y = 60 + (H - Math.min(H, totalSlots)) / 2;
      return ns.map((n) => { const h = n.value * scale; const slot = Math.max(h, SLOT - 10); const r = { n, x: xs[i], y: y + (slot - h) / 2, h, slotTop: y, slot }; y += slot + 10; return r; });
    });
    const bottom = Math.max(...layout.flat().map((r) => (r.slotTop ?? r.y) + (r.slot ?? r.h))) + 24;
    const svg = el('svg', { class: 'flow', viewBox: `0 0 ${W} ${bottom}`, width: W, height: bottom, role: 'img', 'aria-label': spec.summary });
    const band = (x1, y1, x2, y2, t, c, dashed) => { const m = (x1 + x2) / 2; const d = `M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2} L${x2},${y2 + t} C${m},${y2 + t} ${m},${y1 + t} ${x1},${y1 + t} Z`;
      svg.appendChild(el('path', dashed ? { d, fill: 'none', stroke: c, 'stroke-width': 2, 'stroke-dasharray': '6 4' } : { d, fill: c, 'fill-opacity': 0.75 })); };
    for (let i = 0; i < cols.length - 1; i++) {
      const A = layout[i], B = layout[i + 1];
      if (B.length === 1) { let off = 0; const t = B[0]; for (const s of A) { const h = s.n.value * scale; band(s.x + BW, s.y, t.x, t.y + off, h, colour[s.n.dir], s.n.dashed); off += h; } }
      else if (A.length === 1) { let off = 0; const s = A[0]; for (const t of B) { const h = t.n.value * scale; band(s.x + BW, s.y + off, t.x, t.y, h, colour[t.n.dir], t.n.dashed); off += h; } }
    }
    layout.forEach((rs, i) => rs.forEach((r) => {
      const c = r.n.dir === 'bank' ? 'var(--bank)' : (r.n.dir === 'in' ? 'var(--in)' : 'var(--out)');
      svg.appendChild(el('rect', { x: r.x, y: r.y, width: BW, height: Math.max(r.h, 2), fill: c }));
      const first = i === 0, last = i === cols.length - 1, mid = !first && !last || cols.length === 1;
      if (mid || (rs.length === 1 && !first && !last)) {
        const g = el('g'); const cx = r.x + BW / 2;
        g.appendChild(el('text', { x: cx, y: 18, 'text-anchor': 'middle', class: 'lab' }, r.n.label));
        g.appendChild(el('text', { x: cx, y: 44, 'text-anchor': 'middle', class: 'big' }, fmt(r.n.value)));
        if (r.n.sub) g.appendChild(el('text', { x: cx, y: r.y + r.h + 22, 'text-anchor': 'middle', class: 'sub' }, r.n.sub));
        svg.appendChild(g); return;
      }
      const tx = first ? r.x - 12 : r.x + BW + 12, anchor = first ? 'end' : 'start', cy = r.y + r.h / 2;
      svg.appendChild(el('text', { x: tx, y: cy - 4, 'text-anchor': anchor, class: 'lab' }, r.n.label));
      const v = el('text', { x: tx, y: cy + 15, 'text-anchor': anchor, class: 'val' });
      v.appendChild(el('tspan', { fill: r.n.dir === 'out' ? 'var(--out)' : 'var(--in)' }, fmt(r.n.value)));
      if (r.n.sub) v.appendChild(el('tspan', { class: 'sub', dx: 8 }, r.n.sub));
      svg.appendChild(v);
    }));
    box.replaceChildren(svg);
  }

  function narrow(box, spec) {
    const wrap = document.createElement('div'); wrap.className = 'flow-rows'; wrap.setAttribute('role', 'img'); wrap.setAttribute('aria-label', spec.summary);
    const max = Math.max(...spec.cols.flat().filter((n) => n.dir !== 'bank').map((n) => n.value));
    for (const ns of spec.cols) {
      if (ns.length === 1 && ns[0].dir === 'bank') { const n = ns[0]; const d = document.createElement('div'); d.className = 'fr-bank'; d.innerHTML = `<span>${n.label}</span><b>${fmt(n.value)}</b>${n.sub ? `<small>${n.sub}</small>` : ''}`; wrap.appendChild(d); continue; }
      for (const n of ns) { const d = document.createElement('div'); d.className = `fr fr-${n.dir}${n.dashed ? ' fr-dash' : ''}`;
        d.innerHTML = `<span class="fr-l">${n.label}${n.sub ? `<small>${n.sub}</small>` : ''}</span><b>${fmt(n.value)}</b><i style="width:${Math.max(3, (n.value / max) * 100)}%"></i>`; wrap.appendChild(d); }
    }
    box.replaceChildren(wrap);
  }

  function draw() { document.querySelectorAll('[data-flow]').forEach((box) => { const spec = JSON.parse(document.getElementById(box.dataset.flow).textContent); (box.clientWidth < 700 ? narrow : wide)(box, spec); }); }
  draw(); let t; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(draw, 100); });
})();
