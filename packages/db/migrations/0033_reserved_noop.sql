-- 0033 — reserved slot, intentionally a no-op (lead decision DL-0284).
-- 0033 was reserved for T-0039, which needed no migration. The migration runner requires
-- contiguous numbering, and T-0065's 0034 had already been built and tested on top of a gap
-- filler, so this documented no-op occupies the slot. It changes nothing in the database.
-- Supersedes the T-0065 worktree placeholder 0033_local_placeholder_not_committed.sql (DL-0268),
-- which never reached the lead branch.
SELECT 1;
