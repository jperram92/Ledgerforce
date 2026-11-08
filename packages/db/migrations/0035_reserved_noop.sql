-- 0035 — reserved slot, intentionally a no-op (lead decision DL-0287).
-- 0035 was reserved for T-0032 (reversal), which needed no migration (DL-0271). The runner
-- requires contiguous numbering and later parallel tasks already hold 0036..0038, so this
-- documented no-op occupies the slot. It changes nothing in the database.
SELECT 1;
