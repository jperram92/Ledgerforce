import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';
import type { AppEnv } from './env.tsx';

const SAM = { tenant_id: 't1', user_id: 'u1', display_name: 'Sam Nguyen' };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (method: string) => Response | Promise<Response>;

/** A fake of the T-0011 auth API: one handler per path, every call recorded. */
function fakeApi(routes: Record<string, Handler>) {
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : '';
    const handler = routes[path];
    if (!handler) return Promise.resolve(json(404, { error: 'not_found' }));
    return Promise.resolve(handler(init?.method ?? 'GET'));
  });
  const goExternal = vi.fn<(url: string) => void>();
  const env: AppEnv = { apiBase: '', fetch, goExternal };
  return { env, fetch, goExternal };
}

function start(path: string, routes: Record<string, Handler>) {
  const api = fakeApi(routes);
  const history = createMemoryHistory({ initialEntries: [path] });
  render(<App env={api.env} history={history} />);
  return { ...api, history };
}

const SECTIONS = ['Timeline', 'Sales', 'Purchases', 'Bank', 'Reports', 'Settings'];

describe('SS-PLAT-52 sign-in and session handling', () => {
  it('shows a loading state while the session is checked', async () => {
    start('/', { '/auth/me': () => new Promise<Response>(() => undefined) });
    expect((await screen.findByRole('status')).textContent).toContain('Checking your sign-in');
  });

  it('sends a visitor without a session (401) to the sign-in page', async () => {
    const { history } = start('/sales', {
      '/auth/me': () => json(401, { error: 'unauthenticated' }),
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign in to LedgerForce' }),
    ).toBeTruthy();
    expect(history.location.pathname).toBe('/sign-in');
    expect(screen.queryByRole('navigation', { name: 'Sections' })).toBeNull();
  });

  it('a session that ends while the shell is open sends the person to sign-in on the next check', async () => {
    let signedIn = true;
    const { history } = start('/bank', {
      '/auth/me': () => (signedIn ? json(200, SAM) : json(401, { error: 'unauthenticated' })),
    });
    await screen.findByRole('navigation', { name: 'Sections' });
    signedIn = false;
    // TanStack Query re-checks a stale query when the page becomes visible again.
    window.dispatchEvent(new Event('visibilitychange'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign in to LedgerForce' }),
    ).toBeTruthy();
    expect(history.location.pathname).toBe('/sign-in');
    expect(screen.getByRole('status').textContent).toContain('your session has ended');
  });

  it('sign-in sends the browser to the tenant login URL of the API', async () => {
    const user = userEvent.setup();
    const { goExternal } = start('/sign-in', {});
    const box = await screen.findByRole('textbox', { name: "Your organisation's sign-in name" });
    await user.type(box, ' Harbour-Co ');
    await user.click(screen.getByRole('button', { name: 'Continue to sign in' }));
    expect(goExternal).toHaveBeenCalledWith('/t/harbour-co/auth/login');
  });

  it('sign-in refuses a malformed name in place, with the error tied to the field', async () => {
    const user = userEvent.setup();
    const { goExternal } = start('/sign-in', {});
    const box = await screen.findByRole('textbox', { name: "Your organisation's sign-in name" });
    await user.type(box, 'harbour co{Enter}');
    expect(goExternal).not.toHaveBeenCalled();
    expect(box.getAttribute('aria-invalid')).toBe('true');
    const described = (box.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(described).toMatch(/lower-case letters, numbers and hyphens/);
    expect(document.activeElement).toBe(box);
  });

  it('signs out from the user menu with the keyboard and lands on sign-in', async () => {
    const user = userEvent.setup();
    const { fetch, history } = start('/', {
      '/auth/me': () => json(200, SAM),
      '/auth/logout': (m) => (m === 'POST' ? new Response(null, { status: 204 }) : json(405, {})),
    });
    const menu = await screen.findByRole('button', { name: /Sam Nguyen/ });
    menu.focus();
    await user.keyboard('{Enter}');
    const item = await screen.findByRole('menuitem', { name: 'Sign out' });
    await waitFor(() => expect(document.activeElement).toBe(item));
    await user.keyboard('{Enter}');
    expect(await screen.findByText('You have signed out.')).toBeTruthy();
    expect(history.location.pathname).toBe('/sign-in');
    expect(fetch).toHaveBeenCalledWith('/auth/logout', expect.objectContaining({ method: 'POST' }));
  });

  it('tells the person when sign-out did not finish and keeps them in the shell', async () => {
    const user = userEvent.setup();
    start('/', {
      '/auth/me': () => json(200, SAM),
      '/auth/logout': () => json(500, { error: 'boom' }),
    });
    await user.click(await screen.findByRole('button', { name: /Sam Nguyen/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Sign-out did not finish');
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeTruthy();
  });
});

describe('SS-PLAT-53 authenticated shell, navigation and states', () => {
  it('shows the signed-in person and every section, with Timeline current at /', async () => {
    start('/', { '/auth/me': () => json(200, SAM) });
    const nav = await screen.findByRole('navigation', { name: 'Sections' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(SECTIONS);
    expect(within(nav).getByRole('link', { name: 'Timeline' }).getAttribute('aria-current')).toBe(
      'page',
    );
    for (const name of SECTIONS.slice(1)) {
      expect(within(nav).getByRole('link', { name }).getAttribute('aria-current')).toBeNull();
    }
    expect(screen.getByRole('button', { name: /Sam Nguyen/ })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Your money over time');
    expect(screen.getByRole('link', { name: 'Skip to main content' }).getAttribute('href')).toBe(
      '#main',
    );
  });

  it('moves the current section, the heading, the title and focus when navigating', async () => {
    const user = userEvent.setup();
    const { history } = start('/', { '/auth/me': () => json(200, SAM) });
    const nav = await screen.findByRole('navigation', { name: 'Sections' });
    await user.click(within(nav).getByRole('link', { name: 'Sales' }));
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Sales' });
    expect(history.location.pathname).toBe('/sales');
    expect(within(nav).getByRole('link', { name: 'Sales' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(
      within(nav).getByRole('link', { name: 'Timeline' }).getAttribute('aria-current'),
    ).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(h1));
    expect(document.title).toBe('Sales – LedgerForce');
  });

  it.each([
    ['/', 'Nothing on your timeline yet'],
    ['/sales', 'No invoices yet'],
    ['/purchases', 'No bills yet'],
    ['/bank', 'No bank statements yet'],
    ['/reports', 'No reports to show yet'],
    ['/settings', 'Nothing to set up here yet'],
  ])('%s renders an empty state that says what will appear', async (path, heading) => {
    start(path, { '/auth/me': () => json(200, SAM) });
    const h2 = await screen.findByRole('heading', { level: 2, name: heading });
    const region = h2.closest('section');
    expect(region).not.toBeNull();
    expect(region?.getAttribute('data-state')).toBe('empty');
    expect(region?.querySelector('p')?.textContent ?? '').not.toBe('');
  });

  it('shows an error with Retry when the session check fails for another reason', async () => {
    const user = userEvent.setup();
    let fail = true;
    const { history } = start('/', {
      '/auth/me': () => (fail ? json(503, { error: 'unavailable' }) : json(200, SAM)),
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('We could not check your sign-in');
    expect(history.location.pathname).toBe('/');
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('navigation', { name: 'Sections' })).toBeTruthy();
  });

  it('shows a not-found page inside the shell for an unknown path', async () => {
    start('/no-such-page', { '/auth/me': () => json(200, SAM) });
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to your timeline' }).getAttribute('href')).toBe(
      '/',
    );
  });
});
