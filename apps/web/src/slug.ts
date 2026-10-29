/**
 * Tenant sign-in names (slugs). Same rule as the database (migration 0014:
 * `slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`), checked in the browser only so that an
 * obvious typo never leaves the page; the API's 404 for unknown slugs stays the truth (RQ-0025).
 */
export const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export type SlugCheck = { ok: true; slug: string } | { ok: false; message: string };

export function checkSlug(input: string): SlugCheck {
  const slug = input.trim().toLowerCase();
  if (slug === '') return { ok: false, message: "Enter your organisation's sign-in name." };
  if (!SLUG_PATTERN.test(slug)) {
    return {
      ok: false,
      message:
        'Use lower-case letters, numbers and hyphens only (up to 63), with no hyphen at the start or end.',
    };
  }
  return { ok: true, slug };
}
