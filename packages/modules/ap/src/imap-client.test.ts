/**
 * Minimal IMAP4rev1 client (T-0127, ADR-0095, RQ-0177 F2) against the in-process fake server:
 * the read-only protocol subset, literals, the RFC 9051 `n:*` edge case, and the limits that
 * protect the worker from a hostile or broken server. No network.
 */
import { describe, expect, it } from 'vitest';
import { ImapClient, ImapError } from './imap-client.ts';
import { FakeImapServer } from './testing/fake-imap-server.ts';

const MSG1 = Buffer.from(
  'Message-ID: <a@x.example>\r\nSubject: one\r\n\r\nbody with } and {3} braces\r\n',
);
const MSG2 = Buffer.from('Message-ID: <b@x.example>\r\nSubject: two\r\n\r\nsecond\r\n');

function server(): FakeImapServer {
  const s = new FakeImapServer({
    user: 'bills@harbour.example',
    pass: 'app-pass "q" \\ x',
    folders: {
      INBOX: { uidValidity: 3857529045, messages: [] },
      Bills: { uidValidity: 7, messages: [] },
    },
  });
  s.deliver('INBOX', MSG1);
  s.deliver('INBOX', MSG2);
  return s;
}

const MUTATING =
  /^(STORE|UID STORE|EXPUNGE|UID EXPUNGE|COPY|UID COPY|MOVE|UID MOVE|APPEND|DELETE|RENAME|SELECT|CREATE)\b/i;

describe('SS-PLAT-154: IMAP client reads the bills mailbox without changing it', () => {
  it('SS-PLAT-154 logs in, examines, searches above the cursor and fetches size then body', async () => {
    const s = server();
    const c = await ImapClient.connect(() => s.connect());
    await c.login('bills@harbour.example', 'app-pass "q" \\ x');
    const box = await c.examine('INBOX');
    expect(box).toEqual({ uidValidity: 3857529045, exists: 2 });
    expect(await c.searchUidsAfter(0)).toEqual([1, 2]);
    expect(await c.searchUidsAfter(1)).toEqual([2]);
    expect(await c.fetchSizes([1, 2])).toEqual(
      new Map([
        [1, MSG1.length],
        [2, MSG2.length],
      ]),
    );
    expect((await c.fetchMessage(1)).equals(MSG1)).toBe(true);
    await c.logout();
    // Read-only: EXAMINE + BODY.PEEK; nothing that stores flags, moves, expunges or appends.
    expect(s.commands.some((x) => MUTATING.test(x))).toBe(false);
    expect(s.commands.filter((x) => /BODY\[\]/i.test(x) && !/BODY\.PEEK\[\]/i.test(x))).toEqual([]);
  });

  it('SS-PLAT-154 `n:*` above the highest UID matches the last message on the server; the client filters it (RFC 9051)', async () => {
    const s = server();
    const c = await ImapClient.connect(() => s.connect());
    await c.login('bills@harbour.example', 'app-pass "q" \\ x');
    await c.examine('INBOX');
    expect(await c.searchUidsAfter(2)).toEqual([]);
    expect(await c.searchUidsAfter(99)).toEqual([]);
    await c.logout();
  });

  it('SS-PLAT-154 parses FETCH items in any order and a non-ASCII password sent as a literal', async () => {
    const s = new FakeImapServer({
      user: 'bills@harbour.example',
      pass: 'pässwörd',
      folders: { INBOX: { uidValidity: 1, messages: [] } },
    });
    s.deliver('INBOX', MSG2);
    s.faults.bodyFirst = true;
    const c = await ImapClient.connect(() => s.connect());
    await c.login('bills@harbour.example', 'pässwörd');
    await c.examine('INBOX');
    expect((await c.fetchMessage(1)).equals(MSG2)).toBe(true);
    await c.logout();
  });
});

describe('SS-PLAT-156: IMAP failures are classified, bounded and never echo server text', () => {
  const kindOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'resolved';
    } catch (e) {
      expect(e).toBeInstanceOf(ImapError);
      expect((e as Error).message).not.toMatch(/invalid credentials|harbour/);
      return (e as ImapError).kind;
    }
  };

  it('SS-PLAT-156 wrong password → auth_failed; unknown folder → folder_missing', async () => {
    const s = server();
    const c = await ImapClient.connect(() => s.connect());
    expect(await kindOf(c.login('bills@harbour.example', 'wrong'))).toBe('auth_failed');
    c.close();
    const d = await ImapClient.connect(() => s.connect());
    await d.login('bills@harbour.example', 'app-pass "q" \\ x');
    expect(await kindOf(d.examine('Nope'))).toBe('folder_missing');
    d.close();
  });

  it('SS-PLAT-156 a BYE greeting → connect_failed; a silent server → timeout', async () => {
    const s = server();
    s.faults.byeOnGreeting = true;
    expect(await kindOf(ImapClient.connect(() => s.connect()))).toBe('connect_failed');
    const t = server();
    t.faults.silent = true;
    const c = await ImapClient.connect(() => t.connect(), { commandTimeoutMs: 50 });
    expect(await kindOf(c.login('bills@harbour.example', 'app-pass "q" \\ x'))).toBe('timeout');
  });

  it('SS-PLAT-156 a literal above the ceiling or an endless line aborts the connection (too_large / protocol_error)', async () => {
    const s = server();
    s.faults.announceLiteral = 2_000_000;
    const c = await ImapClient.connect(() => s.connect(), { maxLiteralBytes: 1_000_000 });
    await c.login('bills@harbour.example', 'app-pass "q" \\ x');
    await c.examine('INBOX');
    expect(await kindOf(c.fetchMessage(1))).toBe('too_large');
    const h = server();
    h.faults.hugeLine = 70_000;
    expect(
      await kindOf(
        ImapClient.connect(() => h.connect(), { maxLineBytes: 65_536 }).then((x) =>
          x.login('a', 'b'),
        ),
      ),
    ).toBe('protocol_error');
  });

  it('SS-PLAT-156 refuses folder names and usernames it cannot send safely', async () => {
    const s = server();
    const c = await ImapClient.connect(() => s.connect());
    expect(await kindOf(c.login('a\r\nb', 'x'))).toBe('protocol_error');
    c.close();
  });
});
