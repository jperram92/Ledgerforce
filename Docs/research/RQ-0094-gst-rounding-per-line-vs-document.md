---
id: RQ-0094
title: How must GST be rounded on AU tax invoices (per line vs per document), and where does a per-document residue post?
status: answered-pending-human   # technical answer done; Q8 accounting treatment stays with the accountant
opened: 2026-11-08
resolved:
opened_by: claude
linked_tasks: [T-0034]
linked_adrs: []
superseded_by:
---

# RQ-0094 — GST rounding: per line vs per document, and the per-document residue

## Question

- **Q1.** Which GST rounding methods does the ATO accept for amounts shown on a tax invoice, and
  what tie-breaking rule applies?
- **Q2.** Does the choice of method change how tax-inclusive line prices split into net + GST?
- **Q3.** (= `Docs/accounting/postings.md` **Q8**) With per-document rounding on a tax-inclusive
  invoice, should the residue between the document total and Σnet + GST post to the ROUNDING
  system account (design §3.4, drafted in GP-018b) or be absorbed into the largest revenue line?
  Should per-document rounding be offered at all for AU tax invoices?

## Why it matters

T-0034 builds the GST engine. Design §3.4 says "Tax rounding per line or per document is a company
setting (AU default: per line, half-up to cents); the difference to the document total posts to
ROUNDING". GP-018a/b (Draft) give the expected journals. Q3 is an **accounting treatment** and is
therefore a human gate (`AGENTS.md` §6.2, `Docs/process/human-gates.md`); an agent must not decide
it. Guessing wrong would mis-state revenue or GST (BAS 1A) by cents on every affected invoice.

## Sources consulted

Network note: in this build session the egress proxy refused every connection to
`www.ato.gov.au`, `law.ato.gov.au`, `www.legislation.gov.au` and `web.archive.org`
(`curl` → `CONNECT tunnel failed, response 403`, 2026-11-08). The ATO sources below are therefore
cited from the researcher's prior knowledge of the published guidance and are **not re-verified in
this session**; S4–S6 were opened in the repository.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | ATO, "Rounding of GST amounts" (formerly GST Bulletin GSTB 2000/1), https://www.ato.gov.au/ (GST → in detail → rounding) | not retrievable 2026-11-08 (proxy 403); prior knowledge | primary (regulator guidance) | Two accepted methods: the **taxable-supply rule** (work out GST for each taxable supply / line and round each) and the **total-invoice rule** (work out GST on the total of the taxable supplies on the invoice, then round once). Round to the nearest cent; **0.5 cent rounds up**. |
| S2 | ATO GSTR 2013/1 "Goods and services tax: tax invoices", https://law.ato.gov.au/ | not retrievable 2026-11-08 (proxy 403); prior knowledge | primary (public ruling) | A tax invoice must show the GST amount payable (or, if the GST is exactly 1/11 of the price, a statement that the total price includes GST). The GST shown on the invoice is the amount the supplier reports. |
| S3 | A New Tax System (Goods and Services Tax) Act 1999 s 9-70, s 9-75, https://www.legislation.gov.au/ | not retrievable 2026-11-08 (proxy 403); prior knowledge | primary (legislation) | GST on a taxable supply is 10% of its value; value = 10/11 of the price (so GST = 1/11 of a GST-inclusive price). |
| S4 | `Docs/solution-design/solution-design.md` §3.4, §3.6 | 2026-11-08 | primary (project design) | Per-line or per-document is a company setting, AU default per line, half-up to cents; difference to the document total posts to ROUNDING. Tax codes effective-dated with rate and accounts. |
| S5 | `Docs/accounting/postings.md` GP-018 (Draft) and Q8 | 2026-11-08 | primary (project golden, Draft) | 18a per_line: three $3.35 inc lines → net 3.05 each, GST 0.30 each, no ROUNDING line. 18b per_document: GST 10.05/11 → 0.91, nets stay 3.05 ×3 = 9.15, residue 0.01 debited to ROUNDING. Q8 asks whether the residue should instead adjust the largest revenue line. |
| S6 | Spike: `node -e` with decimal.js (repo dependency) computing 335 cents /11 and ×10/11 for k = 1..10 000 cents | 2026-11-08 | experiment | For a single 10% GST-inclusive amount of k cents, `round(10k/11) + round(k/11) = k` for every k tested: a single line never leaves a residue at 10% (the fractional parts of 10k/11 and k/11 sum to exactly 1 cent when 11 ∤ k, and an exact half-cent tie is impossible). Residue only appears when several lines' nets are rounded individually but GST is rounded once on the total. |

Spike S6 (run from `packages/shared`, decimal.js precision 60, ROUND_HALF_UP):

```
node -e "const {Decimal}=require('decimal.js');const D=Decimal.clone({precision:60,rounding:Decimal.ROUND_HALF_UP});
let bad=0;for(let k=1;k<=10000;k++){const g=new D(k);const n=g.times(10).div(11).toDecimalPlaces(0);
const t=g.div(11).toDecimalPlaces(0);if(!n.plus(t).eq(g))bad++;} console.log('k=1..10000 mismatches:',bad); ..."
k=1..10000 mismatches: 0
net 3.05 gst 0.3 doc gst 0.91        # 3.35/1.1, 3.35/11, 10.05/11 — matches GP-018a/b
```

## Findings

1. Both methods are accepted by the ATO for invoice GST (S1). The AU convention is round to the
   nearest cent with a half cent rounding up (S1) — i.e. decimal.js `ROUND_HALF_UP`, which is what
   `@ledgerforce/shared` `Money.roundToCents('half-up')` already does.
2. For a GST-inclusive price the GST is 1/11 of the price at the 10% rate (S3); generalised for a
   rate *r*, GST = price × r / (1 + r). Under the per-line (taxable-supply) rule each line's
   GST is rounded and the net is price − GST, so net + GST = price per line and no residue exists
   (S5 18a; consistent with S6).
3. Under the per-document (total-invoice) rule the GST is rounded once per tax code on the
   document total. If line nets are still rounded individually (as GP-018b drafts), Σnet + GST can
   differ from the document total by a few cents; GP-018b posts that difference to ROUNDING (S4,
   S5). Bound (inference, proven by property test in T-0034): |residue| ≤ (lines + tax-code
   groups) × ½ cent.
4. Q3/Q8 is not answered by any source above: whether the residue belongs in ROUNDING or in a
   revenue line, and whether per-document should be hidden behind an advanced setting, is an
   accounting-policy choice for the accountant / product owner. (Inference: either choice keeps
   the GST shown on the invoice equal to the GST reported, which is what S1/S2 require; the
   difference is only which P&L line carries the cents.)

## Conclusion / decision

- Implement **both** methods as a company setting `tax_rounding` with values `per_line`
  (default, AU) and `per_document`, rounding half-up to the currency's minor unit (cents).
- `per_line`: GST per line = round(net × r) (exclusive) or round(gross × r/(1+r)) (inclusive);
  inclusive net = gross − GST. Residue is always 0.
- `per_document`: GST per tax code = round(Σnet × r) (exclusive) or round(Σgross × r/(1+r))
  (inclusive); inclusive line nets = round(gross / (1+r)) per line; the residue
  `Σnet + ΣGST − document total` is returned to the caller for posting to `system:ROUNDING`
  exactly as drafted in GP-018b (design §3.4). The engine does **not** absorb the residue into a
  revenue line.
- Keep **postings.md Q8 open** for the accountant. If the answer is "adjust the largest revenue
  line", that is a new engine option plus a golden change — a later task, not a silent change.
- Do not hard-code rates in code: the 10% rate lives in tax-code data with `valid_from`
  (2000-07-01, start of GST) so a future rate change is a new effective-dated row.

## Confidence

`medium` for Q1/Q2 (well-known ATO guidance and the Act, but not re-verified in this session
because the regulator sites were unreachable — re-check S1/S2 URLs when network allows and record
the retrieval date here). Q3 is `answered-pending-human`: the build hedges by making the method a
setting, defaulting to the design value, and leaving GP-018 Draft.

## Follow-ups

- Human (accountant): answer postings.md Q8; approve or amend GP-018a/b (gate `golden_postings`).
- Re-verify S1–S3 with retrieval dates when the ATO sites are reachable.
- BAS box mapping per tax code (design §3.6 second bullet) is not part of T-0034; it belongs with
  the BAS report task.

**Affects:** T-0034, T-0040, packages/modules/tax, design §3.4/§3.6, GP-018.
