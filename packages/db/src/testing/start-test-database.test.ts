import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseMode, findPgBinDir } from './start-test-database.ts';

describe('chooseMode', () => {
  it('uses an explicit external URL first', () => {
    expect(chooseMode({ LF_TEST_DATABASE_URL: 'postgres://x' }, true)).toBe('external');
  });
  it('prefers Docker (Testcontainers) when reachable', () => {
    expect(chooseMode({}, true)).toBe('docker');
  });
  it('falls back to a local initdb cluster without Docker (DL-0007)', () => {
    expect(chooseMode({}, false)).toBe('local');
  });
  it('honours LF_TEST_DB_MODE', () => {
    expect(chooseMode({ LF_TEST_DB_MODE: 'local' }, true)).toBe('local');
    expect(() => chooseMode({ LF_TEST_DB_MODE: 'docker' }, false)).toThrow(/Docker/);
    expect(() => chooseMode({ LF_TEST_DB_MODE: 'external' }, false)).toThrow(
      /LF_TEST_DATABASE_URL/,
    );
    expect(() => chooseMode({ LF_TEST_DB_MODE: 'bogus' }, false)).toThrow(/LF_TEST_DB_MODE/);
  });
});

describe('findPgBinDir', () => {
  async function fakeBin(root: string, version: string): Promise<string> {
    const bin = join(root, version, 'bin');
    await mkdir(bin, { recursive: true });
    for (const tool of ['initdb', 'pg_ctl']) {
      await writeFile(join(bin, tool), '#!/bin/sh\n');
      await chmod(join(bin, tool), 0o755);
    }
    return bin;
  }

  it('honours LF_PG_BINDIR', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lf-pgbin-'));
    const bin = await fakeBin(root, '15');
    expect(findPgBinDir({ LF_PG_BINDIR: bin }, [])).toBe(bin);
  });

  it('picks the highest version among candidate roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lf-pgbin-'));
    await fakeBin(root, '9.6');
    await fakeBin(root, '16');
    const bin17 = await fakeBin(root, '17');
    expect(findPgBinDir({}, [root])).toBe(bin17);
  });

  it('explains how to fix a missing installation', () => {
    expect(() => findPgBinDir({ PATH: '' }, ['/definitely/not/here'])).toThrow(/LF_PG_BINDIR/);
  });
});
