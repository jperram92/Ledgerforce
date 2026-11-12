# Accounting-review role port check

Builder: codex. Source: 872c4fa `.claude/agents/accountant-reviewer.md`.
Target: `.claude/agents/accountant-reviewer.md` on feat/T-0167-accounting-review-persona.

This is a builder documentation check, not independent cross-provider approval or an accounting opinion.

| Criterion | Result | Evidence |
| --- | --- | --- |
| AC-1 canonical provenance | PASS | Provenance section pins source 872c4fa and qualifies source DL-0248; canonical DL-0308/0313 and AGENTS.md govern |
| AC-2 AI disclosure | PASS | Required disclosure denies registration, insurance and signing/lodgement authority |
| AC-3 sourced, exact review | PASS | Procedure requires primary texts, applicability dates, inference/access limitations, journal/account/customer/tax/BAS comparisons |
| AC-4 review boundaries | PASS | Authority and final restrictions forbid self-approval, security/release approval and substitution for cross-provider review |

Preserved source intent: the owner does not need to buy an external review service to use this technical review procedure. No claim that an AI is legally equivalent to a registered accountant.

Adaptations: remove misleading practitioner framing; replace static payroll dates and blanket SMB reporting assumptions with applicable-period research; qualify source IDs; explicitly check canonical chart bindings and distinguish provider independence from role names.

No production code, dependency, security gate, approved golden or existing evidence changed by this task. Full repository integration/review gates remain separate.
