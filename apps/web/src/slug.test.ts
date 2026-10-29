import { describe, expect, it } from 'vitest';
import { checkSlug } from './slug.ts';

describe('SS-PLAT-52 checkSlug (migration 0014 slug rule, RQ-0025)', () => {
  it('accepts a lower-case slug and normalises case and spaces', () => {
    expect(checkSlug('harbour-co')).toEqual({ ok: true, slug: 'harbour-co' });
    expect(checkSlug('  Harbour-Co ')).toEqual({ ok: true, slug: 'harbour-co' });
    expect(checkSlug('a')).toEqual({ ok: true, slug: 'a' });
    expect(checkSlug('a'.repeat(63))).toEqual({ ok: true, slug: 'a'.repeat(63) });
  });

  it('asks for a value when empty', () => {
    expect(checkSlug('   ')).toEqual({
      ok: false,
      message: "Enter your organisation's sign-in name.",
    });
  });

  it.each([
    '-harbour',
    'harbour-',
    'harbour co',
    'harbour_co',
    'härbour',
    'a'.repeat(64),
    'x/../y',
  ])('refuses %j with a plain explanation', (input) => {
    expect(checkSlug(input)).toEqual({
      ok: false,
      message:
        'Use lower-case letters, numbers and hyphens only (up to 63), with no hyphen at the start or end.',
    });
  });
});
