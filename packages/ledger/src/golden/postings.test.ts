import { describe, expect, it } from 'vitest';
import { approvedTables, GoldenDraftError, parsePostings } from './postings.ts';

const entry = (id: string, note = '', status = 'Approved') =>
  `## ${id} — fixture\n\n- **Status: ${status}** · Source type: \`manual_journal\`\n${note}\n` +
  '| # | Account | Ref | Debit | Credit | Tax code | Party |\n' +
  '| 1 | system:SUSPENSE | 2900 | 1.00 | | — | — |\n' +
  '| 2 | system:ROUNDING | 6900 | | 1.00 | — | — |\n' +
  '| | **Total** | | **1.00** | **1.00** | | |\n';

describe('append-only golden supersession [T-0166]', () => {
  it('excludes a predecessor only from current replay while preserving its historical tables', () => {
    const parsed = parsePostings(
      entry('GP-900') +
        entry('GP-901', '- **Supersedes GP-900 for current implementation:** correction'),
    );
    expect(parsed[0]).toMatchObject({ status: 'superseded', supersededBy: 'GP-901' });
    expect(parsed[0]?.tables).toHaveLength(1);
    expect(approvedTables(parsed).map((t) => t.entryId)).toEqual(['GP-901']);
  });

  it('does not grant a draft successor authority to retire approved history', () => {
    const parsed = parsePostings(
      entry('GP-900') + entry('GP-901', '- **Supersedes GP-900**', 'Draft'),
    );
    expect(parsed[0]?.status).toBe('approved');
    expect(() => approvedTables(parsed)).toThrow(GoldenDraftError);
  });

  it('does not treat partial wording corrections or prose references as whole-entry supersession', () => {
    const parsed = parsePostings(
      entry('GP-900') + entry('GP-901', '- **Provenance:** Supersedes only the wording in GP-900.'),
    );
    expect(approvedTables(parsed).map((t) => t.entryId)).toEqual(['GP-900', 'GP-901']);
  });

  it('resolves successive approved replacements without losing the intermediate history', () => {
    const parsed = parsePostings(
      entry('GP-900') +
        entry('GP-901', '- **Supersedes GP-900**') +
        entry('GP-902', '- **Supersedes GP-901**'),
    );
    expect(parsed.map((e) => e.supersededBy)).toEqual(['GP-901', 'GP-902', null]);
    expect(approvedTables(parsed).map((t) => t.entryId)).toEqual(['GP-902']);
  });

  it('rejects conflicting approved replacements rather than silently choosing one', () => {
    expect(() =>
      parsePostings(
        entry('GP-900') +
          entry('GP-901', '- **Supersedes GP-900**') +
          entry('GP-902', '- **Supersedes GP-900**'),
      ),
    ).toThrow(/conflicting.*GP-900/i);
  });

  it.each(['GP-899', 'GP-901', 'GP-902'])(
    'rejects missing, self or forward predecessor %s',
    (id) => {
      expect(() =>
        parsePostings(
          entry('GP-900') + entry('GP-901', `- **Supersedes ${id}**`) + entry('GP-902'),
        ),
      ).toThrow(/earlier.*entry/i);
    },
  );
});
