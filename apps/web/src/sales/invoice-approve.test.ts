import { describe, expect, it } from 'vitest';
import { AdminApiError } from '../admin/client.ts';
import { approvalNote, approveRefusalText } from './invoice-approve.ts';

const err = (status: number, body: Record<string, unknown>) => new AdminApiError(status, body);

describe('T-0132: invoice approval in plain words', () => {
  it('explains the separation-of-duties refusal for the creator, with and without small-team mode', () => {
    expect(
      approveRefusalText(
        err(403, {
          error: 'sod_violation',
          rule: 'SOD_INVOICE_SELF_APPROVAL',
          small_team_exception_required: false,
        }),
      ),
    ).toBe(
      'You created this invoice, so you can’t approve it as well. Someone else who can approve invoices has to approve it.',
    );
    expect(
      approveRefusalText(
        err(403, {
          error: 'sod_violation',
          rule: 'SOD_INVOICE_SELF_APPROVAL',
          small_team_exception_required: true,
        }),
      ),
    ).toMatch(/^You created this invoice\. In small-team mode you may approve it if you write why/);
  });

  it('explains already posted, not a draft, a posting refusal and a missing queue', () => {
    expect(approveRefusalText(err(409, { error: 'already_posted' }))).toBe(
      'Someone else has already approved and posted this invoice. Reload the page to see it.',
    );
    expect(approveRefusalText(err(409, { error: 'not_draft' }))).toBe(
      'This invoice is no longer a draft, so it can’t be approved. Reload the page to see it.',
    );
    expect(
      approveRefusalText(err(422, { error: 'PROFILE_GAP', message: 'line 2: no account' })),
    ).toBe('We could not post this invoice: line 2: no account');
    expect(approveRefusalText(err(503, { error: 'outbox_unavailable' }))).toMatch(
      /^LedgerForce can’t post invoices right now\. Nothing was posted/,
    );
  });

  it('falls back to the shared messages; a 401 is routed elsewhere; no error, no text', () => {
    expect(
      approveRefusalText(err(403, { error: 'forbidden', permission: 'ar.invoice.approve' })),
    ).toMatch(/ar\.invoice\.approve/);
    expect(approveRefusalText(err(401, { error: 'step_up_required' }))).toBeNull();
    expect(approveRefusalText(null)).toBeNull();
  });

  it('says beforehand what the rule means for this user', () => {
    expect(approvalNote(null)).toBeNull();
    expect(
      approvalNote({ allowed: true, rule: null, small_team_exception_required: false }),
    ).toBeNull();
    expect(
      approvalNote({
        allowed: false,
        rule: 'SOD_INVOICE_SELF_APPROVAL',
        small_team_exception_required: false,
      }),
    ).toBe(
      'You created this invoice. Someone else who can approve invoices has to approve it, so nobody approves their own work.',
    );
    expect(
      approvalNote({
        allowed: false,
        rule: 'SOD_INVOICE_SELF_APPROVAL',
        small_team_exception_required: true,
      }),
    ).toMatch(/small-team mode/);
  });
});
