/**
 * SS-PLAT-49 (static part) — every tenant route of the API declares its access: a permission from
 * the catalogue, "any member", or public (T-0012, ADR-0023). The interceptor refuses undeclared
 * routes at runtime; this test catches them before they ship.
 */
import 'reflect-metadata';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { isPermission } from '@ledgerforce/shared/rbac';
import { describe, expect, it } from 'vitest';
import { API_CONTROLLERS } from '../app.ts';
import { routeAccess } from './permission.decorator.ts';

type Handler = (...args: unknown[]) => unknown;

function routes(): { name: string; access: ReturnType<typeof routeAccess> }[] {
  const out: { name: string; access: ReturnType<typeof routeAccess> }[] = [];
  for (const cls of API_CONTROLLERS) {
    const proto = cls.prototype as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor') continue;
      const fn = proto[key] as Handler;
      if (typeof fn !== 'function' || Reflect.getMetadata(METHOD_METADATA, fn) === undefined)
        continue;
      out.push({ name: `${cls.name}.${key}`, access: routeAccess(fn, cls) });
    }
  }
  return out;
}

describe('SS-PLAT-49: Every endpoint checks a permission', () => {
  it('finds the routes (positive control)', () => {
    expect(routes().map((r) => r.name)).toEqual(
      expect.arrayContaining([
        'PartyBankAccountsController.list',
        'AuthController.me',
        'UserRolesController.grant',
        'HealthController.check',
      ]),
    );
  });

  it.each(routes().map((r) => [r.name, r.access] as const))(
    '%s declares its access',
    (_n, access) => {
      expect(access.kind).not.toBe('undeclared');
      if (access.kind === 'permission') expect(isPermission(access.permission)).toBe(true);
    },
  );

  it('bank details and role administration need specific permissions', () => {
    const byName = new Map(routes().map((r) => [r.name, r.access]));
    expect(byName.get('PartyBankAccountsController.list')).toEqual({
      kind: 'permission',
      permission: 'parties.bank_account.read',
    });
    expect(byName.get('UserRolesController.list')).toEqual({
      kind: 'permission',
      permission: 'users.read',
    });
    expect(byName.get('UserRolesController.grant')).toEqual({
      kind: 'permission',
      permission: 'users.roles.assign',
    });
  });
});
