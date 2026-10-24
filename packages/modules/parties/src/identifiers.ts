/**
 * Party identifier rules (design §4.2, RQ-0017). The database repeats the ABN rule in
 * app.abn_is_valid(); parties.db.test.ts proves the two agree.
 */

const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19] as const;

/** ABR rule: subtract 1 from the first digit, weight, sum; valid iff the sum mod 89 is 0. */
export function abnIsValid(abn: string): boolean {
  if (!/^[0-9]{11}$/.test(abn)) return false;
  let sum = 0;
  for (let i = 0; i < 11; i += 1) {
    const digit = abn.charCodeAt(i) - 48 - (i === 0 ? 1 : 0);
    sum += digit * (ABN_WEIGHTS[i] ?? 0);
  }
  return sum % 89 === 0;
}

/** Strip spaces; throw unless the result is a valid ABN. */
export function normaliseAbn(input: string): string {
  const abn = input.replace(/\s+/g, '');
  if (!abnIsValid(abn)) throw new RangeError(`${input.trim()} is not a valid ABN`);
  return abn;
}

/** Peppol participant ID for an Australian party identified by ABN: ICD 0151 (ATO). */
export function peppolParticipantId(abn: string): string {
  if (!abnIsValid(abn)) throw new RangeError('Peppol delivery needs a valid ABN');
  return `0151:${abn}`;
}

const SF_SUFFIX_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

function salesforceSuffix(id15: string): string {
  let suffix = '';
  for (let chunk = 0; chunk < 3; chunk += 1) {
    let bits = 0;
    for (let i = 0; i < 5; i += 1) {
      const ch = id15.charAt(chunk * 5 + i);
      if (ch >= 'A' && ch <= 'Z') bits |= 1 << i;
    }
    suffix += SF_SUFFIX_ALPHABET.charAt(bits);
  }
  return suffix;
}

/**
 * Canonical 18-character (case-safe) Salesforce Id. A 15-character Id gets its checksum
 * suffix; an 18-character Id must carry the right one.
 */
export function toSalesforceId18(id: string): string {
  if (!/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(id)) {
    throw new RangeError(`Salesforce Id must be 15 or 18 letters/digits, got "${id}"`);
  }
  const id15 = id.slice(0, 15);
  const expected = salesforceSuffix(id15);
  if (id.length === 18 && id.slice(15).toUpperCase() !== expected) {
    throw new RangeError(`Salesforce Id ${id} fails its checksum (expected suffix ${expected})`);
  }
  return id15 + expected;
}
