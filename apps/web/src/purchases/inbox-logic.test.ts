/** Plain-word logic of the bills inbox (T-0136): the state word and the PDF's size. */
import { describe, expect, it } from 'vitest';
import { fileSize, inboxStatus } from './inbox-logic.ts';

describe('inboxStatus', () => {
  it('says what each inbox state means for the AP Clerk', () => {
    expect(inboxStatus('new')).toEqual({ key: 'new', word: 'To code' });
    expect(inboxStatus('no_attachment')).toEqual({ key: 'no_attachment', word: 'No PDF attached' });
    expect(inboxStatus('coded')).toEqual({ key: 'coded', word: 'Coded into a bill' });
    expect(inboxStatus('rejected')).toEqual({ key: 'rejected', word: 'Rejected' });
  });
});

describe('fileSize', () => {
  it('gives bytes, KB or MB the way a file manager does', () => {
    expect(fileSize(1)).toBe('1 byte');
    expect(fileSize(77)).toBe('77 bytes');
    expect(fileSize(1024)).toBe('1 KB');
    expect(fileSize(48_213)).toBe('48 KB');
    expect(fileSize(1_048_576)).toBe('1.0 MB');
    expect(fileSize(10_485_760)).toBe('10.0 MB');
  });
});
