# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: web/gl.spec.ts >> SS-PLAT-94 manual journals >> SS-PLAT-94: an Auditor reads but cannot act; loading, empty, error and forbidden [T-0082]
- Location: tests/e2e/web/gl.spec.ts:689:3

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: page.evaluate: Test timeout of 30000ms exceeded.
 Please check out https://github.com/dequelabs/axe-core-npm/blob/develop/packages/playwright/error-handling.md
```

# Test source

```ts
  346 |         };
  347 |         const doc = draft(
  348 |           10 + f.docs.length,
  349 |           b.memo ?? '',
  350 |           b.lines.map((l) => ({
  351 |             account: { id: l.account_id },
  352 |             ...(l.debit ? { debit: l.debit } : { credit: l.credit ?? '' }),
  353 |             ...(l.memo ? { memo: l.memo } : {}),
  354 |           })),
  355 |           100 + f.docs.length,
  356 |         );
  357 |         doc.entry_date = b.entry_date;
  358 |         f.docs.push(doc);
  359 |         return send(route, 201, { ...viewOf(doc), replayed: false });
  360 |       }
  361 |       const m = /^\/manual-journals\/([^/]+)(\/[a-z]+)?$/.exec(path);
  362 |       const doc = m ? f.docs.find((d) => d.id === m[1]) : undefined;
  363 |       if (!m || !doc) return send(route, 404, { error: 'not_found' });
  364 |       const rest = m[2] ?? '';
  365 |       if (rest === '' && method === 'GET')
  366 |         return (
  367 |           need('gl.journal.read') ??
  368 |           send(route, 200, {
  369 |             ...viewOf(doc),
  370 |             people: Object.fromEntries(
  371 |               [doc.created_by, doc.submitted_by, doc.approved_by, doc.posted_by]
  372 |                 .filter((x): x is string => x !== null)
  373 |                 .map((x) => [x, NAMES[x] ?? '']),
  374 |             ),
  375 |           })
  376 |         );
  377 |       if (rest === '/preview') {
  378 |         const p = previewOf(doc);
  379 |         return need('gl.journal.read') ?? send(route, p.status, p.body);
  380 |       }
  381 |       if (rest === '/submit') {
  382 |         const p = previewOf(doc);
  383 |         if (p.status !== 200) return send(route, p.status, p.body);
  384 |         const total = (p.body as { total: string }).total;
  385 |         doc.status = 'submitted';
  386 |         doc.submitted_by = ME[f.who].user_id;
  387 |         doc.total = total;
  388 |         doc.approval_required = Number.parseInt(total, 10) > 5000;
  389 |         doc.sensitive_accounts = false;
  390 |         return send(route, 200, {
  391 |           id: doc.id,
  392 |           status: 'submitted',
  393 |           total,
  394 |           approval_required: doc.approval_required,
  395 |           sensitive_accounts: false,
  396 |         });
  397 |       }
  398 |       if (rest === '/approve') {
  399 |         const denied = need('gl.journal.approve');
  400 |         if (denied) return denied;
  401 |         doc.status = 'approved';
  402 |         doc.approved_by = ME[f.who].user_id;
  403 |         return send(route, 200, { id: doc.id, status: 'approved' });
  404 |       }
  405 |       if (rest === '/post') {
  406 |         if (doc.status === 'submitted' && doc.approval_required)
  407 |           return send(route, 409, { error: 'approval_required', message: 'needs approval' });
  408 |         doc.status = 'posted';
  409 |         doc.posted_by = ME[f.who].user_id;
  410 |         doc.entry_no = 'MJ-000042';
  411 |         doc.journal_entry_id = id(0x8502);
  412 |         return send(route, 200, {
  413 |           id: doc.id,
  414 |           status: 'posted',
  415 |           entry_id: doc.journal_entry_id,
  416 |           entry_no: doc.entry_no,
  417 |           entry_date: doc.entry_date,
  418 |           replayed: false,
  419 |         });
  420 |       }
  421 |       return send(route, 404, { error: 'not_found' });
  422 |     },
  423 |   );
  424 |   return f;
  425 | }
  426 | 
  427 | const RENT = id(0x8403);
  428 | const WAITING = id(0x8402);
  429 | const WRITE_OFF = id(0x8404);
  430 | const POSTED = id(0x8401);
  431 | 
  432 | async function open(page: Page, path: string, width: number, scheme: 'light' | 'dark' = 'light') {
  433 |   await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
  434 |   await page.emulateMedia({ colorScheme: scheme });
  435 |   await page.goto(`${origin}${path}`);
  436 |   await expect(page.locator('h1')).toHaveCount(1);
  437 |   await page.evaluate(() => document.fonts.ready);
  438 | }
  439 | 
  440 | async function assertPage(page: Page, width: number) {
  441 |   expect((await page.title()).trim()).not.toBe('');
  442 |   await expect(page.locator('main')).toHaveCount(1);
  443 |   expect(await page.locator('html').getAttribute('lang')).toBe('en-AU');
  444 |   const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  445 |   expect(sw, 'no horizontal scroll').toBeLessThanOrEqual(width);
> 446 |   const axe = await new AxeBuilder({ page })
      |               ^ Error: page.evaluate: Test timeout of 30000ms exceeded.
  447 |     .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
  448 |     .analyze();
  449 |   expect(
  450 |     axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  451 |   ).toEqual([]);
  452 |   const probe = await page.evaluate(genericnessProbe);
  453 |   expect(probe).toEqual({ shadows: [], bigRadius: [], caps: [], purple: [], dots: 0, arrows: 0 });
  454 |   // P12: at most one primary action per view.
  455 |   expect(await page.locator('main .primary').count()).toBeLessThanOrEqual(1);
  456 |   // P3: money cells right-aligned (on wide screens) with tabular figures, two decimals.
  457 |   for (const cell of await page.locator('main [data-amount]').all()) {
  458 |     const style = await cell.evaluate((el) => {
  459 |       const cs = getComputedStyle(el);
  460 |       return { nums: cs.fontVariantNumeric };
  461 |     });
  462 |     expect(style.nums).toContain('tabular-nums');
  463 |     expect(await cell.getAttribute('data-amount')).toMatch(/^-?\d+\.\d{2}$/);
  464 |   }
  465 | }
  466 | 
  467 | async function focusRing(page: Page) {
  468 |   return page.evaluate(() => {
  469 |     const el = document.activeElement;
  470 |     if (!el) return { width: 0 };
  471 |     return { width: Number.parseFloat(getComputedStyle(el).outlineWidth) };
  472 |   });
  473 | }
  474 | 
  475 | test.describe('SS-PLAT-93 chart of accounts', () => {
  476 |   for (const width of [1440, 390] as const) {
  477 |     test(`SS-PLAT-93: an Accountant reads the chart by type @ ${String(width)} [T-0082]`, async ({
  478 |       page,
  479 |       evidence,
  480 |     }) => {
  481 |       const f = await fakeApi(page, 'accountant');
  482 |       await open(page, '/reports', width);
  483 |       await page.getByRole('link', { name: 'Chart of accounts' }).click();
  484 |       await expect(page.getByRole('heading', { level: 1 })).toHaveText('Chart of accounts');
  485 |       await expect(
  486 |         page.getByRole('heading', { level: 2, name: 'Assets — what the business owns' }),
  487 |       ).toBeVisible();
  488 |       const assets = page.getByRole('table', { name: 'Assets' });
  489 |       await expect(assets.getByRole('row')).toHaveCount(6);
  490 |       await expect(assets.getByRole('row', { name: /Trade debtors/ })).toContainText(
  491 |         'Control account: only its ledger posts here; AR_CONTROL',
  492 |       );
  493 |       await expect(
  494 |         page.getByRole('table', { name: 'Equity' }).getByRole('row', { name: /Current year/ }),
  495 |       ).toContainText('Not postable');
  496 |       await assertPage(page, width);
  497 |       await evidence('SS-PLAT-93', `chart-of-accounts-${String(width)}`);
  498 |       expect(f.errors).toEqual([]);
  499 |     });
  500 |   }
  501 | 
  502 |   test('SS-PLAT-93: loading, error, empty and forbidden states [T-0082]', async ({
  503 |     page,
  504 |     evidence,
  505 |   }) => {
  506 |     const f = await fakeApi(page, 'accountant');
  507 |     f.override.set('GET /accounts', 'hold');
  508 |     await open(page, '/accounting/chart', 1440);
  509 |     await expect(page.getByText('Loading the chart of accounts…')).toBeVisible();
  510 |     await evidence('SS-PLAT-93', 'chart-loading-1440');
  511 |     f.override.set('GET /accounts', { status: 503, body: { error: 'down' } });
  512 |     await open(page, '/accounting/chart', 390);
  513 |     await expect(page.getByRole('alert')).toContainText('We could not load the chart of accounts');
  514 |     await assertPage(page, 390);
  515 |     await evidence('SS-PLAT-93', 'chart-error-390');
  516 |     f.override.set('GET /accounts', {
  517 |       status: 200,
  518 |       body: {
  519 |         companies: [{ id: CO, name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' }],
  520 |         accounts: [],
  521 |       },
  522 |     });
  523 |     await open(page, '/accounting/chart', 1440);
  524 |     await expect(
  525 |       page.getByRole('heading', { level: 2, name: 'No chart of accounts yet' }),
  526 |     ).toBeVisible();
  527 |     await assertPage(page, 1440);
  528 |     await evidence('SS-PLAT-93', 'chart-empty-1440');
  529 |     f.who = 'clerk';
  530 |     for (const width of [1440, 390]) {
  531 |       await open(page, '/accounting/chart', width);
  532 |       await expect(
  533 |         page.getByRole('heading', { level: 2, name: "You can't see the chart of accounts" }),
  534 |       ).toBeVisible();
  535 |       await assertPage(page, width);
  536 |       await evidence('SS-PLAT-93', `chart-forbidden-${String(width)}`);
  537 |     }
  538 |   });
  539 | });
  540 | 
  541 | test.describe('SS-PLAT-94 manual journals', () => {
  542 |   for (const width of [1440, 390] as const) {
  543 |     test(`SS-PLAT-94: the journal list, newest first @ ${String(width)} [T-0082]`, async ({
  544 |       page,
  545 |       evidence,
  546 |     }) => {
```