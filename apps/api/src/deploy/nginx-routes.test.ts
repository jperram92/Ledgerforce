/**
 * SS-PLAT-86 — one public origin (T-0094, RQ-0041 finding 7–8, RQ-0025). The `web` service's nginx
 * serves the SPA, proxies the API and Keycloak, and refuses Keycloak's admin paths. The API has
 * no global prefix, so nginx carries an explicit list of API prefixes; this test fails when a
 * controller's prefix is not proxied, or when an SPA route would be swallowed by the API or the IdP.
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_CONTROLLERS } from '../app.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const conf = readFileSync(resolve(ROOT, 'infra/docker/nginx/default.conf.template'), 'utf8');

/** Prefixes from the line `location ~ ^/(a|b|c)(/|$) { # lf:api-prefixes`. */
function proxied(marker: string): string[] {
  const line = conf.split('\n').find((l) => l.includes(marker));
  const m = line ? /\^\/\(([a-z0-9|-]+)\)/.exec(line) : null;
  if (!m?.[1]) throw new Error(`no location line marked ${marker}`);
  return m[1].split('|');
}

function firstSegment(...parts: string[]): string {
  const joined = parts
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0)
    .join('/');
  return joined.split('/')[0] ?? '';
}

/** Top-level segment of every route the API can serve. */
function apiSegments(): Set<string> {
  const out = new Set<string>();
  for (const ctrl of API_CONTROLLERS) {
    const base = String(Reflect.getMetadata('path', ctrl) ?? '/');
    const proto = ctrl.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const fn = proto[name];
      if (name === 'constructor' || typeof fn !== 'function') continue;
      const p: unknown = Reflect.getMetadata('path', fn);
      if (typeof p === 'string') out.add(firstSegment(base, p));
    }
  }
  return out;
}

/** Top-level segment of every SPA route (code-based TanStack routes, RQ-0025). */
function spaSegments(): Set<string> {
  const out = new Set<string>();
  for (const f of ['apps/web/src/sections.ts', 'apps/web/src/router.tsx']) {
    const src = readFileSync(resolve(ROOT, f), 'utf8');
    for (const m of src.matchAll(/\bpath: '([^']*)'/g)) {
      const seg = firstSegment(m[1] ?? '');
      if (seg !== '' && seg !== '$') out.add(seg);
    }
  }
  return out;
}

describe('SS-PLAT-86 one origin: SPA, API and IdP routes through nginx', () => {
  const api = proxied('lf:api-prefixes');
  const idp = proxied('lf:idp-prefixes');

  it('SS-PLAT-86 every API controller route is proxied to the api service', () => {
    const segments = [...apiSegments()].sort();
    expect(segments).toContain('auth');
    expect(segments).toContain('t');
    expect(segments.filter((s) => !api.includes(s))).toEqual([]);
  });

  it('SS-PLAT-86 the proxied API prefixes are exactly the API routes (no stale entries)', () => {
    expect([...api].sort()).toEqual([...apiSegments()].sort());
  });

  it('SS-PLAT-86 no SPA route is shadowed by the API or by Keycloak', () => {
    const spa = [...spaSegments()];
    expect(spa).toEqual(expect.arrayContaining(['sign-in', 'settings', 'reports', 'sales']));
    expect(spa.filter((s) => api.includes(s) || idp.includes(s) || s === 'admin')).toEqual([]);
  });

  it('SS-PLAT-86 only the tenant realm paths of Keycloak are public; /admin and the master realm are refused', () => {
    expect(idp.sort()).toEqual(['realms', 'resources']);
    expect(conf).toMatch(/location \^~ \/admin\/? \{\s*return 404;/);
    expect(conf).toMatch(/location \^~ \/realms\/master\/ \{\s*return 404;/);
  });

  it('SS-PLAT-86 the SPA falls back to index.html and sends basic security headers', () => {
    expect(conf).toMatch(/try_files \$uri \/index\.html;/);
    expect(conf).toMatch(/add_header X-Content-Type-Options "nosniff" always;/);
    expect(conf).toMatch(/add_header Content-Security-Policy "[^"]*frame-ancestors 'none'[^"]*" always;/);
    expect(conf).toMatch(/listen \$\{NGINX_PORT\};/);
  });
});
