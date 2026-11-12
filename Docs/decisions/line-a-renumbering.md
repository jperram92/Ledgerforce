# Line A renumbering map (DL-0285, DL-0286)

Line A branches (`origin/feat/T-0049…T-0080`) were built in parallel with main's later work, so their
IDs collide with IDs that main already uses. On integration, each colliding Line A ID gets a new number
from the integrator range (DL-0287–0399, migrations 0044–0069, ADR-0048–0069, RQ-0101–0119,
T-0127–T-0165). Old commit messages keep the old IDs; this table maps them.

| Line A id | New id | Source branch | Note |
|---|---|---|---|
| DL-0277 | DL-0287 | feat/T-0049-aged-ar | aged receivables decision |
| DL-0278 | DL-0288 | feat/T-0050-bills | decision-log entry (title-matched) |
| DL-0279 | DL-0289 | feat/T-0051-bills-inbox | decision-log entry (title-matched) |
| ADR-0047 (postal-mime) | ADR-0048 | feat/T-0051-bills-inbox | file renamed to Docs/adr/0048-mime-parsing-postal-mime.md |
| RQ-0098 (inbound bill email) | RQ-0101 | feat/T-0051-bills-inbox | file renamed to Docs/research/RQ-0101-inbound-bill-email.md |
| T-0121 (bills inbox transports) | T-0127 | Line A card (arrives with T-0080's chain) | main's T-0121 is the golden-approval/verification task |
| DL-0280 | DL-0290 | feat/T-0052-bill-approval | decision-log entry (title-matched) |
| DL-0281 | DL-0291 | feat/T-0054-payment-batches | decision-log entry (title-matched) |
| DL-0282 | DL-0292 | feat/T-0056-aba-export | decision-log entry (title-matched) |
