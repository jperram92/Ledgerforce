# LedgerForce UI research (T-0009)

Research-led UI direction work, started after the product owner rejected v0.1
(`Docs/ui/mockups`) and v2 "Columnar" (`Docs/ui/v2`) as generic (DL-0052). Research first, then
three directions derived from it, then a recommendation. Status: **awaiting the product owner**.

| Read | What it is |
|---|---|
| [`01-research-report.md`](01-research-report.md) | Users and jobs, competitor and analogue audit, pattern research, why UIs read as "AI", the genericness checklist (G1–G13), 11 insights (INS-01–11), positioning statement, sources |
| [`02-directions.md`](02-directions.md) | Three directions (A Turns, B Flows, C Timeline): idea, insights served, layout, type, colour tokens, tables, journal, SoD, sync, risks, genericness score |
| [`03-recommendation.md`](03-recommendation.md) | Scored comparison, the recommendation (C Timeline with A's queue for list screens), proposed principle changes, user test plan |
| `Docs/research/RQ-0081` … `RQ-0089` | The research questions behind the report, one record each |

## Prototypes and screenshots

Static HTML with realistic Harbour & Co data. Each direction has its own `tokens.css` and bundled
OFL fonts (licence in `fonts/`); no external requests.

| Direction | Owner's home | Invoice INV-001061 with its journal |
|---|---|---|
| A Turns | `directions/a-turns/home.html` → `home-1440.png`, `home-390.png`, `home-1440-dark.png` | `directions/a-turns/invoice.html` → `invoice-1440.png`, `invoice-390.png`, `invoice-1440-dark.png` |
| B Flows | `directions/b-flows/home.html` → `home-1440.png`, `home-390.png` | `directions/b-flows/invoice.html` → `invoice-1440.png`, `invoice-390.png` |
| C Timeline (recommended) | `directions/c-timeline/home.html` → `home-1440.png`, `home-390.png`, `home-1440-dark.png` | `directions/c-timeline/invoice.html` → `invoice-1440.png`, `invoice-390.png`, `invoice-1440-dark.png` |

## Evidence

| File | What |
|---|---|
| `evidence/side-by-side.png` | First screen of rejected v0.1, rejected v2, A, B and C |
| `evidence/silhouette.png` | The same, blurred and greyed (genericness check G13) |
| `evidence/typeface-specimen.png` | Candidate typefaces rendered with money, I/l/1 and O/0 (experiment E1) |
| `evidence/check-report.json` | Per page and viewport: problems found (none), fonts in use, shadow/radius/all-caps/middle-dot/arrow/purple probes |

## Tools

```bash
# Screenshots + checks (one h1, title, main, lang en-AU, console errors, external requests,
# overflow at 390/1440, contrast, optional axe-core WCAG 2.2 A/AA):
AXE_PATH=/path/to/axe.min.js node Docs/ui/research/tools/shot.mjs [filter]
node Docs/ui/research/tools/compare.mjs        # side-by-side and silhouette sheets
node Docs/ui/research/tools/fonttest.mjs <dir-of-fontsource-packages> <out-dir>   # tnum / zero test (E1)
node Docs/ui/research/tools/sheet.mjs <dir-of-fontsource-packages> <out.png>      # specimen sheet
```

`axe-core` 4.14.0 was used from an `npm pack` in a scratch folder; it is **not** a project
dependency. Playwright is resolved from the repository's existing install.
