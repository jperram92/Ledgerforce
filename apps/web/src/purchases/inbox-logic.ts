/**
 * Plain-word logic of the bills inbox (T-0136): the state word of an emailed bill (P2) and the
 * size of its PDF. File sizes are byte counts, not money.
 */
import type { InboxStatus } from './client.ts';

export function inboxStatus(s: InboxStatus): { key: InboxStatus; word: string } {
  switch (s) {
    case 'new':
      return { key: s, word: 'To code' };
    case 'no_attachment':
      return { key: s, word: 'No PDF attached' };
    case 'coded':
      return { key: s, word: 'Coded into a bill' };
    case 'rejected':
      return { key: s, word: 'Rejected' };
  }
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return bytes === 1 ? '1 byte' : `${String(bytes)} bytes`;
  // KB rounded up (a 47.1 KB file is "48 KB"); MB to one decimal, in integer tenths.
  if (bytes < 1024 * 1024) return `${String(Math.ceil(bytes / 1024))} KB`;
  const tenths = Math.round((bytes * 10) / (1024 * 1024));
  return `${String(Math.floor(tenths / 10))}.${String(tenths % 10)} MB`;
}
