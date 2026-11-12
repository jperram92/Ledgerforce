# Line A renumbering map (DL-0285, DL-0286)

Line A branches (`origin/feat/T-0049…T-0080`) were built in parallel with main's later work, so their
IDs collide with IDs that main already uses. On integration, each colliding Line A ID gets a new number
from the integrator range (DL-0287–0399, migrations 0044–0069, ADR-0048–0069, RQ-0101–0119,
T-0127–T-0165). Old commit messages keep the old IDs; this table maps them.

| Line A id | New id | Source branch | Note |
|---|---|---|---|
| DL-0277 | DL-0287 | feat/T-0049-aged-ar | aged receivables decision |
