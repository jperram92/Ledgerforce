/**
 * SS-PLAT-20 (MFA rule) and SS-PLAT-59 (fail-closed step-up), unit part — T-0013, ADR-0025,
 * RQ-0027. The pure rules behind the interceptor's MFA and step-up checks.
 */
import 'reflect-metadata';
import {
  ROLE_IDS,
  ROLE_TEMPLATES,
  STEP_UP_PERMISSIONS,
  rolesRequireMfa,
} from '@ledgerforce/shared/rbac';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MFA_ACR,
  DEFAULT_STEP_UP_MAX_AGE_SECONDS,
  defaultMfaPolicy,
  isMfa,
  stepUpSatisfied,
} from './mfa.ts';
import { RequirePermission, RequireStepUp, routeAccess, stepUpOf } from './permission.decorator.ts';

const NOW = new Date('2026-10-25T10:00:00Z');
const ago = (s: number) => new Date(NOW.getTime() - s * 1000);
const PWD = { amr: ['pwd'], acr: null };
const OTP = { amr: ['pwd', 'otp'], acr: null };

describe('SS-PLAT-20: MFA and session policy for finance roles — MFA rule', () => {
  it('amr with mfa, otp or hwk is MFA; password, sms or an empty amr is not', () => {
    for (const amr of [['pwd', 'otp'], ['mfa'], ['hwk', 'user'], ['otp']]) {
      expect(isMfa({ amr, acr: null }, defaultMfaPolicy), amr.join()).toBe(true);
    }
    for (const amr of [['pwd'], [], ['sms'], ['swk'], ['pin'], ['MFA'], ['otp ']]) {
      expect(isMfa({ amr, acr: null }, defaultMfaPolicy), amr.join()).toBe(false);
    }
  });

  it('a configured MFA acr counts as MFA; any other acr does not', () => {
    expect(isMfa({ amr: ['pwd'], acr: DEFAULT_MFA_ACR }, defaultMfaPolicy)).toBe(true);
    expect(isMfa({ amr: ['pwd'], acr: 'urn:ledgerforce:loa:pwd' }, defaultMfaPolicy)).toBe(false);
    expect(isMfa({ amr: ['pwd'], acr: '1' }, defaultMfaPolicy)).toBe(false);
    expect(isMfa({ amr: ['pwd'], acr: 'gold' }, { acrValues: ['gold'] })).toBe(true);
    expect(isMfa({ amr: ['pwd'], acr: DEFAULT_MFA_ACR }, { acrValues: ['gold'] })).toBe(false);
  });

  it('exactly Owner, Finance Admin, Accountant, AP Clerk and Payroll Officer require MFA (design §6.2)', () => {
    const required = ROLE_IDS.filter((r) => ROLE_TEMPLATES[r].mfaRequired);
    expect(required).toEqual([
      'owner',
      'finance_admin',
      'accountant',
      'ap_clerk',
      'payroll_officer',
    ]);
    for (const r of ROLE_IDS) expect(rolesRequireMfa([r]), r).toBe(ROLE_TEMPLATES[r].mfaRequired);
  });

  it('one finance role among others is enough; unknown role ids and no roles require nothing', () => {
    expect(rolesRequireMfa(['ar_clerk', 'accountant'])).toBe(true);
    expect(rolesRequireMfa(['ar_clerk', 'approver', 'auditor'])).toBe(false);
    expect(rolesRequireMfa(['root'])).toBe(false);
    expect(rolesRequireMfa([])).toBe(false);
  });
});

describe('SS-PLAT-59: Step-up fails closed', () => {
  it('needs MFA and an auth_time no older than max age', () => {
    const p = defaultMfaPolicy;
    expect(stepUpSatisfied({ ...OTP, authTime: ago(299) }, 300, NOW, p)).toBe(true);
    expect(stepUpSatisfied({ ...OTP, authTime: ago(300) }, 300, NOW, p)).toBe(true);
    expect(stepUpSatisfied({ ...OTP, authTime: ago(301) }, 300, NOW, p)).toBe(false);
    expect(stepUpSatisfied({ ...PWD, authTime: ago(1) }, 300, NOW, p)).toBe(false);
    expect(stepUpSatisfied({ ...OTP, authTime: null }, 300, NOW, p)).toBe(false);
  });

  it('an auth_time more than a minute in the future is not accepted', () => {
    const p = defaultMfaPolicy;
    expect(stepUpSatisfied({ ...OTP, authTime: ago(-59) }, 300, NOW, p)).toBe(true);
    expect(stepUpSatisfied({ ...OTP, authTime: ago(-3600) }, 300, NOW, p)).toBe(false);
  });

  it('a route marked @RequireStepUp(n) needs step-up with that max age; the default is 300 s', () => {
    class C {
      @RequirePermission('ap.payment_batch.release')
      @RequireStepUp(120)
      release(): void {}
      @RequirePermission('ap.payment_batch.approve')
      @RequireStepUp()
      approve(): void {}
      @RequirePermission('ap.read')
      read(): void {}
    }
    const of = (name: 'release' | 'approve' | 'read') => {
      const h = C.prototype[name];
      return stepUpOf(h, C, routeAccess(h, C));
    };
    expect(of('release')).toBe(120);
    expect(of('approve')).toBe(DEFAULT_STEP_UP_MAX_AGE_SECONDS);
    expect(DEFAULT_STEP_UP_MAX_AGE_SECONDS).toBe(300);
    expect(of('read')).toBeNull();
  });

  it('a route whose permission is a step-up permission needs step-up even without the decorator', () => {
    expect(STEP_UP_PERMISSIONS).toEqual(
      expect.arrayContaining([
        'ap.payment_batch.release',
        'payroll.net_pay_batch.release',
        'parties.bank_account.change_request',
        'parties.bank_account.verify',
        'period.reopen',
      ]),
    );
    for (const permission of STEP_UP_PERMISSIONS) {
      class C {
        @RequirePermission(permission)
        act(): void {}
      }
      const h = C.prototype.act;
      expect(stepUpOf(h, C, routeAccess(h, C)), permission).toBe(DEFAULT_STEP_UP_MAX_AGE_SECONDS);
    }
  });

  it('@RequireStepUp refuses a max age that is not a whole number of seconds in 1..3600', () => {
    for (const bad of [0, -1, 1.5, 3601, Number.NaN]) {
      expect(() => RequireStepUp(bad), String(bad)).toThrow(/max age/);
    }
  });
});
