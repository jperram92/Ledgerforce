# T-0168 accounting self-review — ADR-0089, GP-040…GP-042, RQ-0171

> This is an AI accounting review, not a registered practitioner. It holds no TPB registration
> or professional indemnity insurance and cannot sign or lodge anything. It provides technical
> findings, not professional certification. The owner chose this approach instead of paid
> external review in the preserved source lineage (872c4fa, source DL-0248).

Reviewer: claude acting as accountant-reviewer (`.claude/agents/accountant-reviewer.md`) on its own
drafting, 2026-11-16. **This is a self-review by the builder, not independent review.** A separate
cross-review follows; it may raise findings that supersede ADR-0089 or the goldens.

## 1. Entity, basis, assumptions

Demo Co Pty Ltd, AUD, GST-registered, accruals (cash variant checked), calendar BAS months.
Acme contract: one supply, completion in December, price 10,000.00 ex GST, cancellable, no tax
invoice before completion. GST 10%, total invoice rule.

## 2. Re-derivation

| Event | Law | Expected GST in period | Golden | BAS via unchanged `bas.ts` (SS-PLAT-135) |
|---|---|---|---|---|
| 1st receipt 3,300 (Nov) | s 29-5(1)(a) whole supply | 1,000.00; G1 11,000.00 | GP-040a | G1 11,000.00, 1A 1,000.00 ✓ |
| 2nd receipt 3,300 (Nov) | already attributed | 0 | GP-040b | 0 ✓ |
| Final invoice, same price | already attributed | 0 | GP-041a | 0 ✓ |
| Final price +500 | Div 19 increasing | 50.00 | GP-041b | G1 550.00, 1A 50.00 ✓ |
| Final price −500 | Div 19 decreasing | −50.00 | GP-041c | G1 −550.00, 1A −50.00 ✓ |
| Cancellation (unbilled 7,000) | Div 19 decreasing | −700.00 | GP-042a | G1 −7,700.00, 1A −700.00 ✓ |
| Refund 3,300 | Div 19 decreasing | −300.00 | GP-042b | G1 −3,300.00, 1A −300.00 ✓ |
| Reversal of 1st receipt, same period | correction | 0 | engine reversal | 0 ✓ |
| Cash basis, any receipt | s 29-5(2) | 1/11 of receipt | GP-020/022 | existing SS-PLAT-102/105 |

Balances re-derived: after 40a, contract liability 3,000 Cr = net cash received; unbilled GST
asset 700 Dr; GST collected 1,000 Cr; bank 3,300 Dr — 3,300 + 700 = 3,000 + 1,000 ✓. After
41a/b/c the liability and unbilled asset are 0.00 and GST collected equals GST on the final
price ✓. After 40a + 42a + 42b every account is 0.00 ✓. Every table balances (runner).

## 3. Findings

- **No BLOCKER.**
- **MAJOR-1 (open, owned by T-0204):** the canonical BAS function accepts either basis for any
  ledger; a cash-basis what-if over an accruals ledger counts GP-040a in full. ADR-0089 R10
  requires a basis guard. Not a lodgement error when the company's basis is used.
- **MAJOR-2 (open, owned by T-0203):** the canonical deposit invoice (GP-014) has no supply
  classification, so a single-supply deposit invoice under-reports on accruals today
  (s 29-5(1)(b)). ADR-0089 R9 refuses it once classification exists; until T-0203 lands the risk
  is the pre-existing canonical behaviour, documented, not introduced here.
- **MINOR-1:** the gross coded line plus uncoded contra on the same account is unusual in a
  journal view; each golden labels the two lines and the BAS-preparation report (T-0204) must
  explain them. Balances are unaffected.
- **MINOR-2:** adjustment-note trigger wording (s 29-75) and GSTR 2001/8 were not read
  (hosts blocked); the design issues adjustment-note particulars unconditionally and refuses
  mixed supplies, which is conservative.
- **MINOR-3:** G1 treatment of adjustments follows the canonical default (net into G1/1A of the
  adjustment period, GP-029/Q4) with the strict 1A/1B setting; consistent, not re-litigated here.
- **INFO:** source 872c4fa ADR-0045 Option A was rejected there because the BAS read a GST debit
  on an asset as a purchase; the canonical design avoids any coded line on the asset.

## 4. Verdict

Treatment consistent with s 29-5, Div 19, Div 99 and Div 156 as read in RQ-0134/RQ-0171 and with
the canonical BAS rules; acceptable for approval under DL-0263 with MAJOR-1/2 carried as named
acceptance criteria on T-0204/T-0203. Independent cross-review pending.
