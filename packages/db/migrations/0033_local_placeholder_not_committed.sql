-- PLACEHOLDER — MUST NOT REACH THE LEAD BRANCH (T-0065, DL-0268).
-- 0033 is reserved for a parallel agent's migration and the runner refuses gaps, so this no-op
-- stood in for it in the T-0065 worktree's test runs. It was meant to stay untracked, but
-- `conductor.ts checkpoint` commits every untracked file and committed it (10d8617). Directive 6
-- forbids deleting it here; at merge the real 0033 supersedes it and this file is left out of the
-- merge result (lead decision, DL-0268). It changes nothing in the database.
SELECT 1;
