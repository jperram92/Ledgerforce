/* LedgerForce mockup shell: icon sprite, primary navigation and top bar.
 * Keeps the 12 mockups consistent without a build step. No network access.
 * Page contract (attributes on <body>):
 *   data-active   nav key, e.g. "invoices"            data-user / data-initials / data-role
 *   data-period   e.g. "Oct 2026"                      data-period-state  "Open" | "AR locked" | "Soft closed" | "Locked"
 *   data-sync     "ok" | "warn" | "err"                data-sync-text      e.g. "Synced 2 min ago"
 * Markup helpers expanded at load:
 *   <i data-i="name"></i>              -> inline SVG icon (aria-hidden)
 *   <span data-chip="paid">Paid</span>  -> status chip: icon + word + colour (principle P2)
 * Icons are simplified Lucide-style glyphs (Lucide is ISC-licensed; apps/web will use lucide-react).
 */
(function () {
  const P = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
    receipt: '<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    bag: '<path d="M5 7h14l-1 14H6z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
    bank: '<path d="M3 21h18M4 10h16M6 10v8M10 10v8M14 10v8M18 10v8M12 3l9 5H3z"/>',
    book: '<path d="M4 19.5V4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>',
    chart: '<path d="M3 3v18h18"/><path d="M8 17v-5M13 17V8M18 17v-9"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.6-1.7"/>',
    cloud: '<path d="M17.5 19H7a5 5 0 1 1 1.2-9.86A6 6 0 0 1 19.5 11a4 4 0 0 1-2 8z"/>',
    settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-right': '<path d="m9 6 6 6-6 6"/>',
    updown: '<path d="m7 15 5 5 5-5M7 9l5-5 5 5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
    filter: '<path d="M3 4h18l-7 8.5V19l-4 2v-8.5z"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
    upload: '<path d="M12 21V9M7 14l5-5 5 5M5 3h14"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    'check-circle': '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>',
    'x-circle': '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>',
    send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    match: '<path d="M4 7h13M7 17h13"/><path d="m14 4 3 3-3 3M10 14l-3 3 3 3"/>',
    equal: '<path d="M5 9h14M5 15h14"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
    flag: '<path d="M4 22V4s1-1 4-1 5 2 8 2 4-1 4-1v11s-1 1-4 1-5-2-8-2-4 1-4 1"/>',
    code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
    play: '<path d="m6 4 14 8-14 8z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/>',
    ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
    dashed: '<circle cx="12" cy="12" r="9" stroke-dasharray="3.5 3"/>',
    pie: '<path d="M21 12A9 9 0 1 1 12 3v9z"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M8 16h8"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    paperclip: '<path d="m21.4 11-8.5 8.5a6 6 0 0 1-8.5-8.5l8.5-8.5a4 4 0 0 1 5.7 5.7L10 16.8a2 2 0 0 1-2.8-2.8l7.8-7.8"/>',
  };
  const CHIPS = {
    draft: ['dashed', 'Draft'], awaiting: ['clock', 'Awaiting approval'], approved: ['check', 'Approved'],
    posted: ['book', 'Posted'], partpaid: ['pie', 'Part paid'], paid: ['check-circle', 'Paid'],
    overdue: ['alert', 'Overdue'], void: ['ban', 'Void'], reversed: ['undo', 'Reversed'], locked: ['lock', 'Locked'],
    info: ['info', ''], warn: ['alert', ''], err: ['x-circle', ''], ok: ['check-circle', ''],
  };
  const svg = (name, cls) => `<svg class="i ${cls || ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${P[name] || P.info}</svg>`;
  window.lfIcon = svg;

  const NAV = [
    { key: 'home', label: 'Home', icon: 'home', href: '01-home-dashboard.html' },
    { key: 'sales', label: 'Sales', icon: 'receipt', href: '02-invoice-list.html', children: [
      { key: 'invoices', label: 'Invoices', href: '02-invoice-list.html' },
      { key: 'batch', label: 'Batch billing', href: '04-batch-billing-run.html' },
      { key: 'customers', label: 'Customers', href: '#' },
      { key: 'receipts', label: 'Receipts', href: '#' } ] },
    { key: 'purchases', label: 'Purchases', icon: 'bag', href: '05-payment-batch-release.html', count: '4', children: [
      { key: 'bills', label: 'Bills', href: '12-mobile-approvals.html', count: '4' },
      { key: 'paybatch', label: 'Payment batches', href: '05-payment-batch-release.html' },
      { key: 'suppliers', label: 'Suppliers', href: '#' } ] },
    { key: 'bank', label: 'Bank', icon: 'bank', href: '06-bank-reconciliation.html', children: [
      { key: 'reconcile', label: 'Reconcile', href: '06-bank-reconciliation.html' },
      { key: 'statements', label: 'Statements', href: '#' } ] },
    { key: 'accounting', label: 'Accounting', icon: 'book', href: '#', children: [
      { key: 'journals', label: 'Journals', href: '#' },
      { key: 'coa', label: 'Chart of accounts', href: '#' },
      { key: 'rules', label: 'Rule studio', href: '11-journal-rule-studio.html' } ] },
    { key: 'reports', label: 'Reports', icon: 'chart', href: '#' },
    { key: 'close', label: 'Close', icon: 'lock', href: '07-period-close-checklist.html' },
    { key: 'sync', label: 'Salesforce sync', icon: 'cloud', href: '09-sync-issues-inbox.html', count: '3', alert: true },
    { key: 'settings', label: 'Settings', icon: 'settings', href: '08-setup-wizard.html' },
  ];

  function renderNav(active) {
    const parentOf = (k) => NAV.find((n) => n.key === k || (n.children || []).some((c) => c.key === k));
    const open = parentOf(active);
    let h = '<a class="brand" href="index.html" aria-label="LedgerForce home"><span class="brand-mark" aria-hidden="true">Lf</span>LedgerForce</a>';
    for (const n of NAV) {
      const isCur = n.key === active;
      const count = n.count && !(open === n && n.children) ? `<span class="count${n.alert ? ' alert' : ''}" aria-label="${n.count} need attention">${n.count}</span>` : '';
      h += `<a class="nav-item" href="${n.href}"${isCur ? ' aria-current="page"' : ''}>${svg(n.icon)}${n.label}${count}</a>`;
      if (n.children && open === n) {
        for (const c of n.children) {
          const cc = c.count ? `<span class="count" aria-label="${c.count} awaiting">${c.count}</span>` : '';
          h += `<a class="nav-item nav-sub" href="${c.href}"${c.key === active ? ' aria-current="page"' : ''}>${c.label}${cc}</a>`;
        }
      }
    }
    h += '<div class="spacer"></div><div class="nav-foot">v0.1 mockup · <a href="index.html">All screens</a></div>';
    return h;
  }

  function renderTop(b) {
    const ps = b.dataset.periodState || 'Open';
    const locked = /lock|closed/i.test(ps);
    const sync = b.dataset.sync || 'ok';
    const syncWord = { ok: 'Salesforce', warn: 'Salesforce', err: 'Salesforce' }[sync];
    return `
      <button class="iconbtn navbtn" type="button" id="lf-navbtn" aria-label="Open navigation" aria-expanded="false" aria-controls="lf-nav">${svg('menu')}</button>
      <button class="switcher" type="button" aria-label="Switch company, current: Harbour &amp; Co Pty Ltd">
        <span class="co-logo" aria-hidden="true">H&amp;</span><span class="co-name">Harbour &amp; Co Pty Ltd</span> ${svg('updown', 'i-sm')}
      </button>
      <div class="search" role="search">${svg('search')}<span>Search invoices, parties, journals…</span><span class="kbd">⌘K</span></div>
      <div class="grow"></div>
      <span class="pill hide-sm" title="Posting period">${svg(locked ? 'lock' : 'calendar', 'i-sm')}Period <b>${b.dataset.period || 'Oct 2026'}</b> · ${ps}</span>
      <a class="pill" href="09-sync-issues-inbox.html" title="Salesforce sync status"><span class="dot ${sync}" aria-hidden="true"></span>${syncWord} <b>${b.dataset.syncText || 'Synced 2 min ago'}</b></a>
      <button class="iconbtn" type="button" aria-label="Notifications, 2 unread">${svg('bell')}<span class="badge" aria-hidden="true"></span></button>
      <button class="iconbtn" type="button" id="lf-theme" aria-label="Toggle dark mode">${svg('moon')}</button>
      <div class="userchip"><span class="avatar" aria-hidden="true">${b.dataset.initials || 'PS'}</span><span class="who">${b.dataset.user || 'Priya Shah'}<small>${b.dataset.role || 'Accountant'}</small></span></div>`;
  }

  function expand(root) {
    root.querySelectorAll('i[data-i]').forEach((el) => { el.outerHTML = svg(el.dataset.i, el.className); });
    root.querySelectorAll('[data-chip]').forEach((el) => {
      const [icon, word] = CHIPS[el.dataset.chip] || CHIPS.info;
      const label = el.textContent.trim() || word;
      el.classList.add('chip', 'st-' + el.dataset.chip);
      el.innerHTML = svg(icon) + label;
      el.removeAttribute('data-chip');
    });
  }

  // Every data table scrolls inside its own keyboard-focusable region, never the page (390px rule).
  function wrapTables(root) {
    root.querySelectorAll('table').forEach((t) => {
      let w = t.parentElement;
      if (!w.classList.contains('table-wrap')) {
        const d = document.createElement('div'); d.className = 'table-wrap';
        t.replaceWith(d); d.appendChild(t); w = d;
      }
      if (!w.hasAttribute('tabindex')) w.setAttribute('tabindex', '0');
      if (!w.hasAttribute('role')) w.setAttribute('role', 'region');
      if (!w.hasAttribute('aria-label')) {
        const cap = t.querySelector('caption');
        w.setAttribute('aria-label', (cap ? cap.textContent.trim() : 'Table') + ' (scrolls sideways)');
      }
    });
  }

  function focusablePre(root) {
    root.querySelectorAll('pre.code').forEach((p) => { if (!p.hasAttribute('tabindex')) p.setAttribute('tabindex', '0'); if (!p.hasAttribute('role')) p.setAttribute('role', 'region'); });
  }

  function init() {
    const b = document.body;
    const nav = document.getElementById('lf-nav');
    if (nav) nav.innerHTML = renderNav(b.dataset.active);
    const top = document.getElementById('lf-top');
    if (top) top.innerHTML = renderTop(b);
    expand(document);
    wrapTables(document);
    focusablePre(document);
    const nb = document.getElementById('lf-navbtn');
    if (nb) nb.addEventListener('click', () => {
      const open = document.body.classList.toggle('nav-open');
      nb.setAttribute('aria-expanded', String(open));
    });
    const t = document.getElementById('lf-theme');
    if (t) t.addEventListener('click', () => {
      const r = document.documentElement;
      r.dataset.theme = r.dataset.theme === 'dark' ? 'light' : 'dark';
    });
    const qs = new URLSearchParams(location.search);
    if (qs.get('theme')) document.documentElement.dataset.theme = qs.get('theme');
    if (qs.get('density')) document.documentElement.dataset.density = qs.get('density');
    document.querySelectorAll('[data-density-toggle] button').forEach((btn) => btn.addEventListener('click', () => {
      document.documentElement.dataset.density = btn.dataset.value;
      btn.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
    }));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
