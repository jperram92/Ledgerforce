// Backlog: load task cards, dependency order, next claimable task, lint.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from './frontmatter.ts';

export const STATUSES = ['todo', 'claimed', 'researching', 'in_progress', 'verifying', 'review', 'done', 'blocked'] as const;
/** statuses that mean "someone is working on it" (a lease applies) */
export const ACTIVE_STATUSES = ['claimed', 'researching', 'in_progress', 'verifying', 'review'];

export interface Card {
  id: string;
  file: string;   // absolute path
  name: string;   // file name
  text: string;
  data: Record<string, any>;
  body: string;
}

const CARD_FILE = /^T-\d+\.md$/;

export function loadCards(dir: string): Card[] {
  if (!existsSync(dir)) return [];
  const out: Card[] = [];
  for (const name of readdirSync(dir).filter((n) => CARD_FILE.test(n)).sort()) {
    const file = join(dir, name);
    const text = readFileSync(file, 'utf8');
    const fm = parseFrontmatter(text);
    out.push({ id: String(fm.data.id ?? name.replace(/\.md$/, '')), file, name, text, data: fm.data, body: fm.body });
  }
  return out;
}

export function deps(card: Card): string[] {
  const d = card.data.depends_on;
  return Array.isArray(d) ? d.map(String) : [];
}

function idNum(id: string): number {
  const m = id.match(/(\d+)/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}
function byId(a: Card, b: Card): number {
  return idNum(a.id) - idNum(b.id) || a.id.localeCompare(b.id);
}

/** Kahn's algorithm; among ready cards the lowest id goes first. Cards in cycles are appended last. */
export function topoOrder(cards: Card[]): Card[] {
  const byKey = new Map(cards.map((c) => [c.id, c]));
  const indeg = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const c of cards) {
    const ds = deps(c).filter((d) => byKey.has(d));
    indeg.set(c.id, ds.length);
    for (const d of ds) children.set(d, [...(children.get(d) ?? []), c.id]);
  }
  const ready = cards.filter((c) => indeg.get(c.id) === 0).sort(byId);
  const out: Card[] = [];
  while (ready.length) {
    const c = ready.shift()!;
    out.push(c);
    for (const k of children.get(c.id) ?? []) {
      indeg.set(k, indeg.get(k)! - 1);
      if (indeg.get(k) === 0) { ready.push(byKey.get(k)!); ready.sort(byId); }
    }
  }
  const rest = cards.filter((c) => !out.includes(c)).sort(byId);
  return [...out, ...rest];
}

export function leaseExpiry(card: Card): number | null {
  const v = card.data.lease_expires_at;
  if (!v) return null;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}

export function isLeaseActive(card: Card, now: number): boolean {
  const t = leaseExpiry(card);
  return ACTIVE_STATUSES.includes(String(card.data.status)) && t !== null && t > now;
}

/** status todo, or an active status whose lease has expired ("claimed-expired"). */
export function isClaimableStatus(card: Card, now: number): boolean {
  const s = String(card.data.status);
  if (s === 'todo') return true;
  return ACTIVE_STATUSES.includes(s) && !isLeaseActive(card, now);
}

export function unmetDeps(card: Card, cards: Card[]): string[] {
  const m = new Map(cards.map((c) => [c.id, c]));
  return deps(card).filter((d) => m.get(d)?.data.status !== 'done');
}

export function nextClaimable(cards: Card[], now: number): Card | undefined;
export function nextClaimable(cards: Card[], now: number, count: number): Card[];
export function nextClaimable(cards: Card[], now: number, count?: number): Card | Card[] | undefined {
  const list = topoOrder(cards).filter((c) => isClaimableStatus(c, now) && unmetDeps(c, cards).length === 0);
  return count === undefined ? list[0] : list.slice(0, count);
}

/** Validate every card; returns human-readable error strings (empty = OK). */
export function lintBacklog(root: string, backlogRel: string): string[] {
  const dir = join(root, backlogRel);
  const errors: string[] = [];
  if (!existsSync(dir)) return errors;
  const cards: Card[] = [];
  for (const name of readdirSync(dir).filter((n) => CARD_FILE.test(n)).sort()) {
    const text = readFileSync(join(dir, name), 'utf8');
    let data: Record<string, any>;
    try {
      data = parseFrontmatter(text).data;
    } catch (e) {
      errors.push(`${name}: invalid frontmatter — ${(e as Error).message}`);
      continue;
    }
    const id = data.id === undefined || data.id === null ? '' : String(data.id);
    if (!id) errors.push(`${name}: missing id`);
    else if (`${id}.md` !== name) errors.push(`${name}: id ${id} does not match file name`);
    if (!data.title) errors.push(`${name}: missing title`);
    if (!STATUSES.includes(data.status)) errors.push(`${name}: status "${data.status}" is not one of ${STATUSES.join('|')}`);
    if (data.depends_on !== undefined && data.depends_on !== null && !Array.isArray(data.depends_on)) {
      errors.push(`${name}: depends_on must be a list`);
    }
    if (data.status === 'blocked' && !data.blocked_reason) errors.push(`${name}: status blocked requires blocked_reason`);
    cards.push({ id: id || name, file: join(dir, name), name, text, data, body: '' });
  }
  const seen = new Map<string, string>();
  for (const c of cards) {
    if (seen.has(c.id)) errors.push(`duplicate id ${c.id} in ${seen.get(c.id)} and ${c.name}`);
    else seen.set(c.id, c.name);
  }
  for (const c of cards) {
    for (const d of deps(c)) if (!seen.has(d)) errors.push(`${c.name}: depends_on ${d} does not exist`);
  }
  // cycles: whatever Kahn cannot order is in (or behind) a cycle
  const uniq = [...new Map(cards.map((c) => [c.id, c])).values()];
  const ordered = new Set<string>();
  {
    const indeg = new Map(uniq.map((c) => [c.id, deps(c).filter((d) => seen.has(d)).length]));
    const q = uniq.filter((c) => indeg.get(c.id) === 0).map((c) => c.id);
    while (q.length) {
      const id = q.shift()!;
      ordered.add(id);
      for (const c of uniq) if (deps(c).includes(id)) { indeg.set(c.id, indeg.get(c.id)! - 1); if (indeg.get(c.id) === 0) q.push(c.id); }
    }
  }
  const cyclic = uniq.filter((c) => !ordered.has(c.id)).map((c) => c.id);
  if (cyclic.length) errors.push(`dependency cycle among: ${cyclic.join(', ')}`);
  // success scenarios must exist in the register (when the register exists)
  const reg = join(root, 'Docs/specs/success-scenarios.md');
  if (existsSync(reg)) {
    const regText = readFileSync(reg, 'utf8');
    for (const c of cards) {
      const ss = c.data.success_scenarios;
      if (!Array.isArray(ss)) continue;
      for (const s of ss.map(String)) {
        if (!new RegExp(`(^|[^A-Za-z0-9-])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9-]|$)`, 'm').test(regText)) {
          errors.push(`${c.name}: success scenario ${s} not found in Docs/specs/success-scenarios.md`);
        }
      }
    }
  }
  return errors;
}
