# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: web/sync-issues.spec.ts >> SS-PLAT-99 retry and ignore >> SS-PLAT-99: status decides the actions; refusals in plain words; step-up [T-0092]
- Location: tests/e2e/web/sync-issues.spec.ts:685:3

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: page.evaluate: Test timeout of 30000ms exceeded.
```

# Test source

```ts
  278 |     async (route) => {
  279 |       const req = route.request();
  280 |       const url = new URL(req.url());
  281 |       const path = url.pathname;
  282 |       const method = req.method();
  283 |       if (path === '/auth/step-up') {
  284 |         return route.fulfill({
  285 |           status: 200,
  286 |           contentType: 'text/html',
  287 |           body: '<!doctype html><html lang="en"><title>Identity provider</title><h1>Confirm it is you (test stand-in)</h1></html>',
  288 |         });
  289 |       }
  290 |       const o = f.override.get(`${method} ${path}`);
  291 |       if (o === 'hold') return; // never answered: the loading state stays
  292 |       if (o) return send(route, o.status, o.body);
  293 |       const me = ME[f.who];
  294 |       if (path === '/auth/me')
  295 |         return send(route, 200, {
  296 |           tenant_id: 't-harbour',
  297 |           user_id: me.user_id,
  298 |           display_name: me.display_name,
  299 |         });
  300 |       if (path === '/auth/me/access')
  301 |         return send(route, 200, {
  302 |           roles: me.roles,
  303 |           permissions: f.who === 'owner' ? [...ALL_PERMISSIONS].sort() : permissionsOf(me.roles),
  304 |         });
  305 |       if (path === '/users') {
  306 |         return send(route, 200, [
  307 |           { id: SAM, display_name: 'Sam Nguyen', email: 'sam@harbour.example', status: 'active' },
  308 |           { id: MEI, display_name: 'Mei Tan', email: 'mei@harbour.example', status: 'active' },
  309 |         ]);
  310 |       }
  311 |       const may = (p: string) =>
  312 |         f.who === 'owner' || (permissionsOf(ME[f.who].roles) as readonly string[]).includes(p);
  313 |       if (path === '/sync-issues' && method === 'GET') {
  314 |         f.gets.push(url.search);
  315 |         if (!may('sync.issues.read'))
  316 |           return send(route, 403, { error: 'forbidden', permission: 'sync.issues.read' });
  317 |         const q = url.searchParams;
  318 |         const status = q.get('status');
  319 |         const limit = Number(q.get('limit') ?? '50');
  320 |         let rows = f.issues.filter((i) => !status || i.status === status);
  321 |         const after = q.get('after');
  322 |         if (after) rows = rows.slice(rows.findIndex((i) => i.id === after) + 1);
  323 |         const page1 = rows.slice(0, limit);
  324 |         return send(route, 200, {
  325 |           issues: page1.map(view),
  326 |           next_after: rows.length > limit ? (page1.at(-1)?.id ?? null) : null,
  327 |         });
  328 |       }
  329 |       const m = /^\/sync-issues\/([^/]+)(\/retry|\/ignore)?$/.exec(path);
  330 |       if (m) {
  331 |         const target = f.issues.find((i) => i.id === m[1]);
  332 |         if (!target) return send(route, 404, { error: 'not_found' });
  333 |         if (!m[2] && method === 'GET') {
  334 |           if (!may('sync.issues.read'))
  335 |             return send(route, 403, { error: 'forbidden', permission: 'sync.issues.read' });
  336 |           return send(route, 200, target);
  337 |         }
  338 |         if (method !== 'POST') return send(route, 404, { error: 'not_found' });
  339 |         const body: unknown = req.postData() ? req.postDataJSON() : undefined;
  340 |         f.posts.push({ path, body });
  341 |         if (!may('sync.issues.manage'))
  342 |           return send(route, 403, { error: 'forbidden', permission: 'sync.issues.manage' });
  343 |         const now = '2026-10-26T00:15:00.000Z';
  344 |         if (m[2] === '/retry') {
  345 |           if (target.status === 'resolved')
  346 |             return send(route, 409, { error: 'sync_issue_not_retryable' });
  347 |           if (target.status !== 'retried')
  348 |             Object.assign(target, {
  349 |               status: 'retried',
  350 |               retry_job_id: 'job-new',
  351 |               status_changed_by: ME[f.who].user_id,
  352 |               status_changed_at: now,
  353 |             });
  354 |           return send(route, 200, view(target));
  355 |         }
  356 |         if (target.status === 'ignored') return send(route, 200, view(target));
  357 |         if (target.status !== 'open')
  358 |           return send(route, 409, { error: 'sync_issue_not_ignorable' });
  359 |         Object.assign(target, {
  360 |           status: 'ignored',
  361 |           note: (body as { note?: string } | undefined)?.note ?? null,
  362 |           status_changed_by: ME[f.who].user_id,
  363 |           status_changed_at: now,
  364 |         });
  365 |         return send(route, 200, view(target));
  366 |       }
  367 |       return send(route, 404, { error: 'not_found' });
  368 |     },
  369 |   );
  370 |   return f;
  371 | }
  372 | 
  373 | async function open(page: Page, path: string, width: number, scheme: 'light' | 'dark' = 'light') {
  374 |   await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
  375 |   await page.emulateMedia({ colorScheme: scheme });
  376 |   await page.goto(`${origin}${path}`);
  377 |   await expect(page.locator('h1')).toHaveCount(1);
> 378 |   await page.evaluate(() => document.fonts.ready);
      |              ^ Error: page.evaluate: Test timeout of 30000ms exceeded.
  379 | }
  380 | 
  381 | async function assertPage(page: Page, width: number) {
  382 |   expect((await page.title()).trim()).not.toBe('');
  383 |   await expect(page.locator('main')).toHaveCount(1);
  384 |   expect(await page.locator('html').getAttribute('lang')).toBe('en-AU');
  385 |   const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  386 |   expect(sw, 'no horizontal scroll').toBeLessThanOrEqual(width);
  387 |   const axe = await new AxeBuilder({ page })
  388 |     .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
  389 |     .analyze();
  390 |   expect(
  391 |     axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  392 |   ).toEqual([]);
  393 |   const probe = await page.evaluate(genericnessProbe);
  394 |   expect(probe).toEqual({ shadows: [], bigRadius: [], caps: [], purple: [], dots: 0, arrows: 0 });
  395 |   // P12: at most one primary action per view.
  396 |   expect(await page.locator('main .primary').count()).toBeLessThanOrEqual(1);
  397 |   // P2: every status word has text.
  398 |   for (const t of await page.locator('main .word[data-status]').allTextContents()) {
  399 |     expect(t.trim()).not.toBe('');
  400 |   }
  401 | }
  402 | 
  403 | async function focusRing(page: Page) {
  404 |   return page.evaluate(() => {
  405 |     const el = document.activeElement;
  406 |     if (!el) return { style: 'none', width: 0 };
  407 |     const cs = getComputedStyle(el);
  408 |     return { style: cs.outlineStyle, width: Number.parseFloat(cs.outlineWidth) };
  409 |   });
  410 | }
  411 | 
  412 | test.describe('SS-PLAT-97 sync issues inbox', () => {
  413 |   for (const width of [1440, 390] as const) {
  414 |     test(`SS-PLAT-97: an Accountant opens the inbox from Settings @ ${String(width)} [T-0092]`, async ({
  415 |       page,
  416 |       evidence,
  417 |     }) => {
  418 |       const f = await fakeApi(page, 'accountant');
  419 |       await open(page, '/settings', width);
  420 |       await page.getByRole('link', { name: 'Salesforce sync issues' }).click();
  421 |       await expect(page.getByRole('heading', { level: 1 })).toHaveText('Salesforce sync issues');
  422 |       await expect(
  423 |         page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Settings' }),
  424 |       ).toHaveAttribute('aria-current', 'page');
  425 |       const table = page.getByRole('table', { name: 'Sync issues' });
  426 |       await expect(table.getByRole('row')).toHaveCount(4);
  427 |       await expect(table.getByRole('row').nth(1)).toContainText('Invoice INV-001052');
  428 |       await expect(table.getByRole('row').nth(1)).toContainText('Salesforce refused the change');
  429 |       await expect(table.getByRole('row').nth(1)).toContainText('Needs a person');
  430 |       await expect(table.getByRole('row').nth(2)).toContainText(
  431 |         'Salesforce refused one or more records',
  432 |       );
  433 |       await expect(table.getByRole('row').nth(3)).toContainText(
  434 |         'Your Salesforce org reached its API limit',
  435 |       );
  436 |       await expect(
  437 |         page.getByRole('navigation', { name: 'Filter by status' }).getByRole('link', {
  438 |           name: 'Needs a person',
  439 |         }),
  440 |       ).toHaveAttribute('aria-current', 'page');
  441 |       await expect(page.getByText('Your books are not affected')).toBeVisible();
  442 |       expect(f.gets).toEqual(['?status=open&limit=20']);
  443 |       await assertPage(page, width);
  444 |       await evidence('SS-PLAT-97', `inbox-open-accountant-${String(width)}`);
  445 |       expect(f.errors).toEqual([]);
  446 |     });
  447 |   }
  448 | 
  449 |   test('SS-PLAT-97: filter by status and page through all issues [T-0092]', async ({
  450 |     page,
  451 |     evidence,
  452 |   }) => {
  453 |     const f = await fakeApi(page, 'owner');
  454 |     await open(page, '/settings/sync-issues', 1440);
  455 |     const filter = page.getByRole('navigation', { name: 'Filter by status' });
  456 |     await filter.getByRole('link', { name: 'Ignored' }).click();
  457 |     await expect(page).toHaveURL(/\?status=ignored$/);
  458 |     const table = page.getByRole('table', { name: 'Sync issues' });
  459 |     await expect(table.getByRole('row')).toHaveCount(2);
  460 |     await expect(table).toContainText('Credit note CN-000044');
  461 |     await expect(table).toContainText('Ignored');
  462 |     await assertPage(page, 1440);
  463 |     await evidence('SS-PLAT-97', 'inbox-ignored-filter-1440');
  464 |     await filter.getByRole('link', { name: 'All' }).click();
  465 |     await expect(table.getByRole('row')).toHaveCount(21);
  466 |     await expect(page.getByRole('link', { name: 'First page' })).toHaveCount(0);
  467 |     await page.getByRole('link', { name: 'Next page' }).click();
  468 |     await expect(page).toHaveURL(/\?status=all&after=/);
  469 |     await expect(table.getByRole('row')).toHaveCount(5);
  470 |     await expect(page.getByRole('link', { name: 'Next page' })).toHaveCount(0);
  471 |     await expect(filter.getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'page');
  472 |     await assertPage(page, 1440);
  473 |     await evidence('SS-PLAT-97', 'inbox-all-second-page-1440');
  474 |     await page.getByRole('link', { name: 'First page' }).click();
  475 |     await expect(page).toHaveURL(/\?status=all$/);
  476 |     await expect(table.getByRole('row')).toHaveCount(21);
  477 |     expect(f.gets.slice(-3)).toEqual([
  478 |       '?limit=20',
```