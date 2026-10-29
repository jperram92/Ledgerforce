// Small shared helpers: clock (overridable for tests), timestamps, shell-word splitting.
import { renameSync, writeFileSync } from 'node:fs';

/** Current time in ms. `LF_NOW` (ISO timestamp) freezes the clock — used by tests and dry runs. */
export function now(): number {
  const fixed = process.env.LF_NOW;
  if (fixed) {
    const t = Date.parse(fixed);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}

export function iso(t: number): string {
  return new Date(t).toISOString();
}

/** 2026-10-24T05:30:00.000Z → 20261024T053000Z (safe in ref and file names) */
export function stamp(t: number): string {
  return iso(t).replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function today(t: number): string {
  return iso(t).slice(0, 10);
}

/** Split a command string into argv, honouring single/double quotes and backslash escapes. */
export function shellWords(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) { q = null; continue; }
      if (c === '\\' && q === '"' && i + 1 < s.length) { cur += s[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (has || cur) { out.push(cur); cur = ''; has = false; } continue; }
    cur += c;
  }
  if (q) throw new Error(`unterminated quote in command: ${s}`);
  if (has || cur) out.push(cur);
  return out;
}

/** Quote an argv element for display (POSIX shell). */
export function shellQuote(a: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'task';
}

export class ExitError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** Exit codes (documented in README.md). */
export const EXIT = {
  OK: 0,
  ERROR: 1,      // usage error, unexpected failure, lint failure, expired leases found
  REFUSED: 2,    // validation refused the operation (bad status, unmet deps, held lease, missing arg)
  EXHAUSTED: 3,  // every provider is out of quota / credit / budget
  BLOCKED: 4,    // task blocked (max attempts reached or agent marked it blocked)
} as const;

/**
 * Write a file so concurrent readers see either the old or the new content, never a partial one:
 * write a sibling temp file, then rename over the target (atomic on POSIX and on NTFS when the
 * target is replaced in the same directory). Cards, state and HANDOVER are read by the agent's own
 * conductor commands while `run` rewrites them, so every such write must go through here.
 */
export function writeFileAtomic(file: string, text: string): void {
  const tmp = `${file}.${String(process.pid)}.${String(Date.now())}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, text);
  for (let attempt = 0; ; attempt++) {
    try { renameSync(tmp, file); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || attempt >= 50 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error;
      // A reader/virus scanner may briefly deny replacement on Windows. Keep the
      // original destination intact; retry the same atomic rename, never unlink it.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
}
