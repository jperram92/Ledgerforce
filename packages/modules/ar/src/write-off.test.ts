import { describe, expect, it } from 'vitest';
import { writeOffInvoice } from './write-off.ts';

describe('writeOffInvoice input validation', () => {
  it('rejects an impossible calendar date as INVALID_WRITE_OFF before database access', async () => {
    await expect(
      writeOffInvoice(undefined as never, {
        companyId: '00000000-0000-4000-8000-000000000001',
        invoiceId: '00000000-0000-4000-8000-000000000002',
        writeOffDate: '2026-99-99',
        reason: 'Customer insolvency',
      }),
    ).rejects.toMatchObject({
      name: 'WriteOffError',
      code: 'INVALID_WRITE_OFF',
    });
  });
});
