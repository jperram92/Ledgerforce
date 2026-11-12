# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: web/admin.spec.ts >> SS-PLAT-79 weekly control exceptions >> SS-PLAT-79: an empty week, an error and the forbidden state [T-0093]
- Location: tests/e2e/web/admin.spec.ts:719:3

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: page.goto: Test timeout of 30000ms exceeded.
Call log:
  - navigating to "http://127.0.0.1:37703/reports/control-exceptions", waiting until "load"

```

# Test source

```ts
  282 |         f.people.push(p);
  283 |         f.people.sort((a, c) => a.display_name.localeCompare(c.display_name));
  284 |         return send(route, 201, {
  285 |           id: p.id,
  286 |           email: p.email,
  287 |           display_name: p.display_name,
  288 |           status: 'invited',
  289 |           roles: b.roles,
  290 |         });
  291 |       }
  292 |       const m = /^\/users\/([^/]+)(\/.*)?$/.exec(path);
  293 |       if (m) {
  294 |         const target = f.people.find((p) => p.id === m[1]);
  295 |         if (!target) return send(route, 404, { error: 'not_found' });
  296 |         const rest = m[2] ?? '';
  297 |         if (rest === '' && method === 'GET') return send(route, 200, target);
  298 |         if (rest === '/roles' && method === 'POST') {
  299 |           const role = (body as { role: string }).role;
  300 |           if (target.id === me.user_id) return send(route, 403, { error: 'self_grant' });
  301 |           target.roles = [...new Set([...target.roles, role])].sort();
  302 |           return send(route, 201, {
  303 |             id: 'r-new',
  304 |             user_id: target.id,
  305 |             role,
  306 |             granted_at: new Date().toISOString(),
  307 |           });
  308 |         }
  309 |         const rv = /^\/roles\/([^/]+)\/revoke$/.exec(rest);
  310 |         if (rv && method === 'POST') {
  311 |           target.roles = target.roles.filter((r) => r !== rv[1]);
  312 |           return send(route, 200, { user_id: target.id, role: rv[1], revoked: true });
  313 |         }
  314 |         if (rest === '/offboard' && method === 'POST') {
  315 |           const b = body as { reason: string; successor_user_id?: string };
  316 |           const revoked = target.roles.length;
  317 |           Object.assign(target, {
  318 |             status: 'disabled',
  319 |             roles: [],
  320 |             disabled_at: new Date().toISOString(),
  321 |             disable_reason: b.reason,
  322 |             successor_user_id: b.successor_user_id ?? null,
  323 |           });
  324 |           return send(route, 200, {
  325 |             user_id: target.id,
  326 |             status: 'disabled',
  327 |             changed: true,
  328 |             sessions_revoked: 2,
  329 |             tokens_revoked: 1,
  330 |             roles_revoked: revoked,
  331 |             successor_user_id: b.successor_user_id ?? null,
  332 |             approvals_assignee: b.successor_user_id ?? null,
  333 |             pending: { period_reopen_requests: [] },
  334 |           });
  335 |         }
  336 |       }
  337 |       if (path === '/sod/exceptions/weekly') {
  338 |         const wk = url.searchParams.get('week_start') ?? f.week.week_start;
  339 |         return send(
  340 |           route,
  341 |           200,
  342 |           wk === f.week.week_start
  343 |             ? f.week
  344 |             : { ...f.week, week_start: wk, acknowledged_at: null, exceptions: [] },
  345 |         );
  346 |       }
  347 |       if (path === '/sod/exceptions/weekly/acknowledge') {
  348 |         f.week.acknowledged_at = '2026-10-25T00:20:00.000Z';
  349 |         f.week.exceptions = f.week.exceptions.map((e) => ({ ...e, acknowledged: true }));
  350 |         return send(route, 201, {
  351 |           week_start: f.week.week_start,
  352 |           exceptions: f.week.exceptions.length,
  353 |         });
  354 |       }
  355 |       if (path === '/audit-log') {
  356 |         const q = url.searchParams;
  357 |         let rows = AUDIT.filter(
  358 |           (e) =>
  359 |             (!q.get('actor') || e.actor_user_id === q.get('actor')) &&
  360 |             (!q.get('action') ||
  361 |               e.action.toLowerCase().includes((q.get('action') ?? '').toLowerCase())) &&
  362 |             (!q.get('entity_type') || e.entity_type === q.get('entity_type')) &&
  363 |             (!q.get('before') || Number(e.id) < Number(q.get('before'))),
  364 |         );
  365 |         const limit = Number(q.get('limit') ?? '5');
  366 |         const more = rows.length > limit;
  367 |         rows = rows.slice(0, limit);
  368 |         return send(route, 200, {
  369 |           entries: rows,
  370 |           next_before: more ? (rows.at(-1)?.id ?? null) : null,
  371 |         });
  372 |       }
  373 |       return send(route, 404, { error: 'not_found' });
  374 |     },
  375 |   );
  376 |   return f;
  377 | }
  378 | 
  379 | async function open(page: Page, path: string, width: number, scheme: 'light' | 'dark' = 'light') {
  380 |   await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
  381 |   await page.emulateMedia({ colorScheme: scheme });
> 382 |   await page.goto(`${origin}${path}`);
      |              ^ Error: page.goto: Test timeout of 30000ms exceeded.
  383 |   await expect(page.locator('h1')).toHaveCount(1);
  384 |   await page.evaluate(() => document.fonts.ready);
  385 | }
  386 | 
  387 | async function assertPage(page: Page, width: number) {
  388 |   expect((await page.title()).trim()).not.toBe('');
  389 |   await expect(page.locator('main')).toHaveCount(1);
  390 |   expect(await page.locator('html').getAttribute('lang')).toBe('en-AU');
  391 |   const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  392 |   expect(sw, 'no horizontal scroll').toBeLessThanOrEqual(width);
  393 |   const axe = await new AxeBuilder({ page })
  394 |     .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
  395 |     .analyze();
  396 |   expect(
  397 |     axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  398 |   ).toEqual([]);
  399 |   const probe = await page.evaluate(genericnessProbe);
  400 |   expect(probe).toEqual({ shadows: [], bigRadius: [], caps: [], purple: [], dots: 0, arrows: 0 });
  401 |   // P12: at most one primary action per view.
  402 |   expect(await page.locator('main .primary').count()).toBeLessThanOrEqual(1);
  403 | }
  404 | 
  405 | async function focusRing(page: Page) {
  406 |   return page.evaluate(() => {
  407 |     const el = document.activeElement;
  408 |     if (!el) return { style: 'none', width: 0 };
  409 |     const cs = getComputedStyle(el);
  410 |     return { style: cs.outlineStyle, width: Number.parseFloat(cs.outlineWidth) };
  411 |   });
  412 | }
  413 | 
  414 | test.describe('SS-PLAT-78 people and roles', () => {
  415 |   for (const width of [1440, 390] as const) {
  416 |     test(`SS-PLAT-78: the Owner sees people with roles and status @ ${String(width)} [T-0093]`, async ({
  417 |       page,
  418 |       evidence,
  419 |     }) => {
  420 |       const f = await fakeApi(page, 'owner');
  421 |       await open(page, '/settings', width);
  422 |       await page.getByRole('link', { name: 'People and roles' }).click();
  423 |       await expect(page.getByRole('heading', { level: 1 })).toHaveText('People and roles');
  424 |       await expect(
  425 |         page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Settings' }),
  426 |       ).toHaveAttribute('aria-current', 'page');
  427 |       const table = page.getByRole('table', { name: 'People' });
  428 |       await expect(table.getByRole('row')).toHaveCount(7);
  429 |       await expect(table.getByRole('row', { name: /Mei Tan/ })).toContainText(
  430 |         'Approver, Finance Admin',
  431 |       );
  432 |       await expect(table.getByRole('row', { name: /Gus Webb/ })).toContainText('Disabled');
  433 |       await expect(table.getByRole('row', { name: /Priya Shah/ })).toContainText('Invited');
  434 |       await expect(page.getByRole('button', { name: 'Send invitation' })).toBeVisible();
  435 |       await assertPage(page, width);
  436 |       await evidence('SS-PLAT-78', `people-list-owner-${String(width)}`);
  437 |       expect(f.errors).toEqual([]);
  438 |     });
  439 |   }
  440 | 
  441 |   test('SS-PLAT-78: the Owner invites someone by keyboard [T-0093]', async ({ page, evidence }) => {
  442 |     const f = await fakeApi(page, 'owner');
  443 |     await open(page, '/settings/users', 1440);
  444 |     await page.getByLabel('Full name').focus();
  445 |     expect((await focusRing(page)).width).toBeGreaterThanOrEqual(2);
  446 |     await page.keyboard.type('Noah Clarke');
  447 |     await page.keyboard.press('Tab');
  448 |     await page.keyboard.type('noah@harbour.example');
  449 |     await page.keyboard.press('Tab');
  450 |     await page.keyboard.type('https://id.harbour.example');
  451 |     await page.keyboard.press('Tab');
  452 |     await page.keyboard.type('noah.clarke');
  453 |     await page.keyboard.press('Tab'); // Owner
  454 |     await page.keyboard.press('Tab'); // Finance Admin
  455 |     await page.keyboard.press('Tab'); // Accountant
  456 |     await page.keyboard.press('Space');
  457 |     await expect(page.getByRole('checkbox', { name: 'Accountant' })).toBeChecked();
  458 |     await evidence('SS-PLAT-78', 'invite-form-filled-1440');
  459 |     await page.getByRole('button', { name: 'Send invitation' }).focus();
  460 |     await page.keyboard.press('Enter');
  461 |     await expect(page.getByRole('status')).toHaveText(
  462 |       'Invited Noah Clarke. They become active the first time they sign in, after setting up two-step sign-in.',
  463 |     );
  464 |     await expect(
  465 |       page.getByRole('table', { name: 'People' }).getByRole('row', { name: /Noah Clarke/ }),
  466 |     ).toContainText('Invited');
  467 |     expect(f.posts).toEqual([
  468 |       {
  469 |         path: '/users',
  470 |         body: {
  471 |           email: 'noah@harbour.example',
  472 |           display_name: 'Noah Clarke',
  473 |           idp_issuer: 'https://id.harbour.example',
  474 |           idp_subject: 'noah.clarke',
  475 |           roles: ['accountant'],
  476 |         },
  477 |       },
  478 |     ]);
  479 |     await assertPage(page, 1440);
  480 |     await evidence('SS-PLAT-78', 'invite-sent-1440');
  481 |     expect(f.errors).toEqual([]);
  482 |   });
```