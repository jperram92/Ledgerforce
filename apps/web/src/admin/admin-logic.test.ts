/**
 * SS-PLAT-78..80 — the admin screens' pure logic (T-0093): plain-word messages for every API
 * refusal (P6), role and SoD rule names, the step-up URL (ADR-0025), week arithmetic for the
 * weekly report and the audit-log query string.
 */
import { ROLE_IDS, ROLE_TEMPLATES } from '@ledgerforce/shared/rbac';
import { SOD_RULES } from '@ledgerforce/shared/sod';
import { describe, expect, it, vi } from 'vitest';
import { AdminApiError, auditQueryString, createAdminClient } from './client.ts';
import { addDays, dayLabel, mondayOf } from './dates.ts';
import { API_ERROR_CODES, messageFor, roleName, ruleText } from './messages.ts';
import { stepUpUrl } from './stepUp.ts';

describe('SS-PLAT-78: every API refusal has a plain-word message (P6)', () => {
  it.each(API_ERROR_CODES)('%s maps to its own sentence', (code) => {
    const m = messageFor(new AdminApiError(400, { error: code }));
    expect(m.length).toBeGreaterThanOrEqual(20);
    expect(m).not.toBe(messageFor(new AdminApiError(400, { error: 'never_heard_of_it' })));
  });

  it('a self-grant refusal says why and who can do it instead', () => {
    expect(messageFor(new AdminApiError(403, { error: 'self_grant' }))).toBe(
      "You can't give yourself a role. Another Owner or Finance Admin has to do it, so nobody widens their own access.",
    );
  });

  it('a permission refusal names what was needed', () => {
    expect(
      messageFor(new AdminApiError(403, { error: 'forbidden', permission: 'users.manage' })),
    ).toContain('users.manage');
  });

  it('an unknown code still says something useful, with the code for support', () => {
    const m = messageFor(new AdminApiError(409, { error: 'never_heard_of_it' }));
    expect(m).toContain('never_heard_of_it');
    expect(messageFor(new Error('offline'))).toBe(
      'LedgerForce did not answer. Check your connection, then try again.',
    );
  });

  it('every role and every SoD rule has a name in plain words', () => {
    for (const r of ROLE_IDS) expect(roleName(r)).toBe(ROLE_TEMPLATES[r].name);
    expect(roleName('mystery')).toBe('mystery');
    for (const rule of SOD_RULES) {
      expect(ruleText(rule.id).length, rule.id).toBeGreaterThanOrEqual(20);
      expect(ruleText(rule.id), rule.id).not.toContain('SOD_');
    }
    expect(ruleText('SOD_SOMETHING_NEW')).toBe('SOD_SOMETHING_NEW');
  });
});

describe('SS-PLAT-78: step-up challenges go to the step-up flow (ADR-0025)', () => {
  it('builds /auth/step-up with max_age and the current path as return_to', () => {
    expect(stepUpUrl('', 300, '/settings/users/abc?x=1')).toBe(
      '/auth/step-up?max_age=300&return_to=%2Fsettings%2Fusers%2Fabc%3Fx%3D1',
    );
    expect(stepUpUrl('https://books.example', 60, '/')).toBe(
      'https://books.example/auth/step-up?max_age=60&return_to=%2F',
    );
  });

  it('a missing or invalid max_age falls back to the default 300 seconds', () => {
    expect(stepUpUrl('', undefined, '/')).toBe('/auth/step-up?max_age=300&return_to=%2F');
    expect(stepUpUrl('', 0, '/')).toBe('/auth/step-up?max_age=300&return_to=%2F');
    expect(stepUpUrl('', 3601, '/')).toBe('/auth/step-up?max_age=300&return_to=%2F');
    expect(stepUpUrl('', 3600, '/')).toBe('/auth/step-up?max_age=3600&return_to=%2F');
  });

  it('never sends an off-site return_to: anything not starting with one "/" becomes "/"', () => {
    expect(stepUpUrl('', 300, '//evil.example/x')).toBe('/auth/step-up?max_age=300&return_to=%2F');
    expect(stepUpUrl('', 300, 'https://evil.example')).toBe(
      '/auth/step-up?max_age=300&return_to=%2F',
    );
  });
});

describe('SS-PLAT-79: weeks of the exceptions report', () => {
  it('adds days to a calendar date across month and year ends', () => {
    expect(addDays('2026-10-19', 7)).toBe('2026-10-26');
    expect(addDays('2026-10-26', -7)).toBe('2026-10-19');
    expect(addDays('2026-12-28', 7)).toBe('2027-01-04');
    expect(addDays('2024-02-26', 7)).toBe('2024-03-04');
  });

  it('finds the Monday of any date', () => {
    expect(mondayOf('2026-10-19')).toBe('2026-10-19');
    expect(mondayOf('2026-10-25')).toBe('2026-10-19');
    expect(mondayOf('2026-10-21')).toBe('2026-10-19');
    expect(mondayOf('2027-01-01')).toBe('2026-12-28');
  });

  it('labels a day in Australian English', () => {
    expect(dayLabel('2026-10-19')).toBe('Monday 19 October 2026');
  });
});

describe('SS-PLAT-80: audit-log queries', () => {
  it('sends only non-empty filters, trimmed, in a fixed order', () => {
    expect(auditQueryString({})).toBe('');
    expect(auditQueryString({ to: '2026-10-23', action: ' roles ', actor: '', before: '42' })).toBe(
      '?action=roles&to=2026-10-23&before=42',
    );
  });

  it('keeps the API error code and body on a refusal', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'step_up_required', max_age: 120 }), { status: 401 }),
      ),
    );
    const client = createAdminClient({ apiBase: '', fetch });
    const err = await client.offboard('u-1', { reason: 'left' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminApiError);
    expect(err).toMatchObject({ status: 401, code: 'step_up_required', body: { max_age: 120 } });
    expect(fetch).toHaveBeenCalledWith('/users/u-1/offboard', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'left' }),
    });
  });

  it('a refusal without a JSON body still has a code', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response('bad gateway', { status: 502 })),
    );
    const err = await createAdminClient({ apiBase: '', fetch })
      .auditLog({})
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: 'http_502' });
    expect(fetch.mock.calls[0]?.[0]).toBe('/audit-log');
  });
});
