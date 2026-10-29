// Cross-provider review reports: .agent/evidence/<T-ID>/review-<provider>-<YYYYMMDD-HHMMSS>.md
// (format: .claude/agents/reviewer.md → "# Cross-review T-NNNN — PASS|FAIL|NEEDS-HUMAN").
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Review { file: string; provider: string; verdict: 'PASS' | 'FAIL' | 'NEEDS-HUMAN' | 'UNKNOWN' }

export function reviews(root: string, evidenceRel: string, id: string): Review[] {
  const dir = join(root, evidenceRel, id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^review-[a-z0-9_]+-.*\.md$/i.test(f))
    .sort()
    .map((f) => {
      const text = readFileSync(join(dir, f), 'utf8');
      const m = text.match(/^#\s*Cross-review\b.*?\b(PASS|FAIL|NEEDS-HUMAN)\b/m)
        ?? text.match(/Overall verdict:?\s*\**\s*(PASS|FAIL|NEEDS-HUMAN)\b/i);
      return {
        file: join(evidenceRel, id, f),
        provider: f.replace(/^review-/, '').split('-')[0],
        verdict: (m ? m[1].toUpperCase() : 'UNKNOWN') as Review['verdict'],
      };
    });
}

/** Latest review by a provider other than the builder (self-reviews never count). */
export function latestCrossReview(root: string, evidenceRel: string, id: string, builder: string | null): Review | null {
  const list = reviews(root, evidenceRel, id).filter((r) => r.provider !== builder);
  return list.length ? list[list.length - 1] : null;
}
