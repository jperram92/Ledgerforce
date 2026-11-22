/**
 * Small helpers of the logo, accent colour and Stripe payout parts of Numbering and billing
 * (T-0195, ADR-0100). The API decides; these only read the chosen file and say refusals in words.
 */
import { describe, expect, it } from 'vitest';
import { AdminApiError } from '../admin/client.ts';
import { accentToSend, base64OfDataUrl, billingRefusal, logoFileProblem } from './billing-logic.ts';

describe('SS-PLAT-171 T-0195 logo and accent colour helpers', () => {
  it('SS-PLAT-171 says before sending when the chosen file is not a PNG or JPEG or is over 512 KB', () => {
    expect(logoFileProblem({ type: 'image/png', size: 2048 })).toBeNull();
    expect(logoFileProblem({ type: 'image/jpeg', size: 512 * 1024 })).toBeNull();
    expect(logoFileProblem({ type: 'image/svg+xml', size: 100 })).toBe(
      'Choose a PNG or JPEG file. SVG and other formats are not accepted: export the logo as PNG.',
    );
    expect(logoFileProblem({ type: 'image/png', size: 512 * 1024 + 1 })).toBe(
      'The logo file is larger than 512 KB. Export it smaller, for example 600 pixels wide.',
    );
    expect(logoFileProblem({ type: 'image/png', size: 0 })).toBe('The chosen file is empty.');
  });

  it('SS-PLAT-171 takes the base64 part of a data URL, only for PNG or JPEG', () => {
    expect(base64OfDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe('iVBORw0KGgo=');
    expect(base64OfDataUrl('data:image/jpeg;base64,/9j/4AAQ')).toBe('/9j/4AAQ');
    expect(base64OfDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(base64OfDataUrl('not a data url')).toBeNull();
  });

  it('SS-PLAT-171 sends the accent colour when typed, null to remove a saved one, nothing otherwise', () => {
    expect(accentToSend(' #f2a900 ', null)).toEqual({ brand_accent_colour: '#f2a900' });
    expect(accentToSend('', '#F2A900')).toEqual({ brand_accent_colour: null });
    expect(accentToSend('  ', null)).toEqual({});
  });
});

describe('SS-PLAT-172 T-0195 payout refusals', () => {
  it('SS-PLAT-172 says the payout, fee, party and size refusals in plain words', () => {
    const said = (status: number, error: string) =>
      billingRefusal(new AdminApiError(status, { error, message: 'm' }));
    expect(said(422, 'INVALID_FEE_ACCOUNT')).toMatch(/expense account/);
    expect(said(422, 'INVALID_PAYOUT_ACCOUNT')).toMatch(/bank account/);
    expect(said(422, 'INVALID_STRIPE_PARTY')).toMatch(/active supplier/);
    expect(said(413, 'payload_too_large')).toMatch(/512 KB/);
  });
});
