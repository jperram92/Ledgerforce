import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './api.ts';

function env(response: Response | Promise<Response>) {
  const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response));
  return { fetch, apiBase: '', goExternal: vi.fn<(url: string) => void>() };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('SS-PLAT-52 API client for the auth endpoints of T-0011', () => {
  it('reads /auth/me with the session cookie', async () => {
    const e = env(json(200, { tenant_id: 't1', user_id: 'u1', display_name: 'Sam Nguyen' }));
    const me = await createApiClient(e).me();
    expect(me).toEqual({ tenant_id: 't1', user_id: 'u1', display_name: 'Sam Nguyen' });
    expect(e.fetch).toHaveBeenCalledWith('/auth/me', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
  });

  it('turns a 401 into an ApiError with status 401', async () => {
    const e = env(json(401, { error: 'unauthenticated' }));
    const err = await createApiClient(e)
      .me()
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });

  it('refuses a 200 that is not the /auth/me shape', async () => {
    const e = env(json(200, { hello: 'world' }));
    await expect(createApiClient(e).me()).rejects.toBeInstanceOf(ApiError);
  });

  it('prefixes the API base', async () => {
    const e = { ...env(json(200, { tenant_id: 't', user_id: 'u', display_name: 'A' })) };
    e.apiBase = 'https://books.example';
    await createApiClient(e).me();
    expect(e.fetch.mock.calls[0]?.[0]).toBe('https://books.example/auth/me');
  });

  it('signs out with POST /auth/logout; 204 and 401 both mean signed out', async () => {
    const ok = env(new Response(null, { status: 204 }));
    await expect(createApiClient(ok).logout()).resolves.toBeUndefined();
    expect(ok.fetch).toHaveBeenCalledWith('/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    const gone = env(json(401, { error: 'unauthenticated' }));
    await expect(createApiClient(gone).logout()).resolves.toBeUndefined();
  });

  it('reports other sign-out failures', async () => {
    const e = env(json(500, { error: 'boom' }));
    await expect(createApiClient(e).logout()).rejects.toMatchObject({ status: 500 });
  });

  it('builds the tenant login URL from a checked slug', () => {
    expect(createApiClient(env(json(200, {}))).loginUrl('harbour-co')).toBe(
      '/t/harbour-co/auth/login',
    );
  });
});
