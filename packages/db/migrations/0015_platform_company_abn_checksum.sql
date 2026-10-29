-- 0015 — platform: a company's ABN must pass the ABR checksum (T-0107, RQ-0017).
-- Owner: packages/db (platform).
--
-- Migration 0002 checked app.company.abn only against ^[0-9]{11}$. Party ABNs already use
-- app.abn_is_valid (migration 0011). A company ABN prints on every tax invoice, so it meets the
-- same rule. Added NOT VALID, then VALIDATEd: if any stored ABN fails, this migration stops with
-- an error naming the constraint, and the bad value must be reported to the human, never
-- silently changed (directive 6).

ALTER TABLE app.company ADD CONSTRAINT company_abn_checksum CHECK (app.abn_is_valid(abn)) NOT VALID;
ALTER TABLE app.company VALIDATE CONSTRAINT company_abn_checksum;
