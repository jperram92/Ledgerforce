/* LedgerForce v2 mockup shell: masthead (letterhead), index tabs and sub-navigation.
 * Page contract (attributes on <body>):
 *   data-tab      top-level tab key, e.g. "sales"        data-sub     sub-nav key, e.g. "invoices"
 *   data-user / data-role                                 data-period  e.g. "Oct 2026"
 *   data-period-state  "Open" | "Soft closed" | "Locked"  data-sync    "ok" | "warn" | "err"   data-sync-text
 * Expanded at load:  <span data-stamp="paid"></span>  ->  rubber stamp with its standard word
 */
(function () {
  const STAMPS = { draft: 'Draft', awaiting: 'Awaiting approval', approved: 'Approved', posted: 'Posted', partpaid: 'Part paid', paid: 'Paid', overdue: 'Overdue', void: 'Void', reversed: 'Reversed', locked: 'Locked', excluded: 'Excluded' };

  const TABS = [
    { key: 'home', label: 'Day book', href: '01-home-dashboard.html' },
    { key: 'sales', label: 'Sales', href: '02-invoice-list.html', subs: [
      ['invoices', 'Invoices', '02-invoice-list.html', '31'], ['batch', 'Batch billing', '04-batch-billing-run.html'], ['receipts', 'Receipts', '#'], ['customers', 'Customers', '#'], ['statements', 'Statements', '#'] ] },
    { key: 'purchases', label: 'Purchases', href: '05-payment-batch-release.html', ct: '4', subs: [
      ['bills', 'Bills', '12-mobile-approvals.html', '4'], ['paybatch', 'Payment batches', '05-payment-batch-release.html'], ['suppliers', 'Suppliers', '#'] ] },
    { key: 'bank', label: 'Bank', href: '06-bank-reconciliation.html', subs: [
      ['reconcile', 'Reconcile', '06-bank-reconciliation.html', '6'], ['statements', 'Statements', '#'], ['rules', 'Matching rules', '#'] ] },
    { key: 'ledger', label: 'Ledger', href: '#', subs: [
      ['journals', 'Journals', '#'], ['coa', 'Chart of accounts', '#'], ['rules', 'Rule studio', '11-journal-rule-studio.html'] ] },
    { key: 'reports', label: 'Reports', href: '#' },
    { key: 'close', label: 'Close', href: '07-period-close-checklist.html' },
    { key: 'sync', label: 'Salesforce', href: '09-sync-issues-inbox.html', ct: '3', alert: true },
    { key: 'settings', label: 'Settings', href: '08-setup-wizard.html', subs: [
      ['setup', 'Setup', '08-setup-wizard.html'], ['users', 'Users & approvals', '#'], ['tax', 'Tax codes', '#'] ] },
  ];

  function masthead(b) {
    const ps = b.dataset.periodState || 'Open';
    const locked = /lock|closed/i.test(ps);
    const sync = b.dataset.sync || 'ok';
    return `
      <a class="wordmark" href="index.html" aria-label="LedgerForce, all screens"><span class="folio" aria-hidden="true">Lf</span>LedgerForce</a>
      <div class="letterhead"><b>Harbour &amp; Co Pty Ltd</b><span>ABN 74 625 118 903</span></div>
      <div class="grow"></div>
      <span class="datestamp${locked ? ' locked' : ''}" title="Posting period"><small>Period</small><b>${b.dataset.period || 'Oct 2026'} · ${ps}</b></span>
      <a class="syncmark ${sync}" href="09-sync-issues-inbox.html"><span class="lamp" aria-hidden="true"></span><span>Salesforce</span><span class="txt">${b.dataset.syncText || 'in sync'}</span></a>
      <div class="who">${b.dataset.user || 'Priya Shah'}<small>${b.dataset.role || 'Accountant'}</small></div>
      <button class="btn sm" type="button" id="lf-theme" aria-label="Switch light or dark">Dark</button>`;
  }

  function tabs(active) {
    return TABS.map((t) => {
      const ct = t.ct ? `<span class="ct${t.alert ? ' alert' : ''}">${t.ct}</span>` : '';
      return `<a href="${t.href}"${t.key === active ? ' aria-current="page"' : ''}>${t.label}${ct}</a>`;
    }).join('');
  }

  function subnav(active, sub) {
    const t = TABS.find((x) => x.key === active);
    if (!t || !t.subs) return '';
    return t.subs.map(([k, label, href, ct]) => `<a href="${href}"${k === sub ? ' aria-current="page"' : ''}>${label}${ct ? `<span class="ct">${ct}</span>` : ''}</a>`).join('');
  }

  function init() {
    const b = document.body;
    const m = document.getElementById('lf-masthead'); if (m) m.innerHTML = masthead(b);
    const t = document.getElementById('lf-tabs'); if (t) t.innerHTML = tabs(b.dataset.tab);
    const s = document.getElementById('lf-subnav');
    if (s) { const h = subnav(b.dataset.tab, b.dataset.sub); if (h) s.innerHTML = h; else s.remove(); }
    document.querySelectorAll('[data-stamp]').forEach((el) => {
      const k = el.dataset.stamp; el.classList.add('stamp', k);
      if (!el.textContent.trim()) el.textContent = STAMPS[k] || k;
    });
    document.querySelectorAll('.scroll').forEach((w) => { if (!w.hasAttribute('tabindex')) { w.tabIndex = 0; w.setAttribute('role', 'region'); if (!w.hasAttribute('aria-label')) w.setAttribute('aria-label', 'Table (scrolls sideways)'); } });
    const qs = new URLSearchParams(location.search);
    if (qs.get('theme')) document.documentElement.dataset.theme = qs.get('theme');
    if (qs.get('density')) document.documentElement.dataset.density = qs.get('density');
    const th = document.getElementById('lf-theme');
    const isDark = () => { const t = document.documentElement.dataset.theme; return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; };
    const label = () => { if (th) th.textContent = isDark() ? 'Light' : 'Dark'; };
    label();
    if (th) th.addEventListener('click', () => { const r = document.documentElement; r.dataset.theme = isDark() ? 'light' : 'dark'; label(); });
    document.querySelectorAll('[data-density-toggle] button').forEach((btn) => btn.addEventListener('click', () => {
      document.documentElement.dataset.density = btn.dataset.value;
      btn.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
    }));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
