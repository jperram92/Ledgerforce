# infra — compose, helm, terraform

> Local rules for this directory. They **add to** the root [`AGENTS.md`](../AGENTS.md) and
> never contradict it; if they seem to, the root file wins. `CLAUDE.md` here only imports this file.

## What lives here
Deployment definitions (design §7.2): Docker Compose for the single-VM self-host, Helm chart for
Kubernetes, Terraform for the hosted SaaS.

## Local rules
- **No secrets** in any file: use placeholders and references to a secret store (KMS/Vault);
  never commit `.env*`, keys, certificates or real hostnames of customer environments.
- Database roles: migrations run as `lf_migrator`; the application runs as `lf_app` without
  `BYPASSRLS` and without trigger-disable privilege. Never configure the app with the owner or a
  superuser role.
- TLS 1.2+ (1.3 preferred), encryption at rest, backups with point-in-time recovery
  (targets RPO 15 min, RTO 4 h for hosted — design §6.9).
- Images are signed and ship an SBOM; CI security gates are human-owned — do not edit them.
- Hosted region default is Australia (design §7.2); data-region choices are a human decision.
- Infra changes that alter the security model need a `security` ADR (human gate).
- Local agent environments may lack Docker: integration tests must not require compose
  (DL-0007).

## Tests
Validate templates where tooling is available (`docker compose config`, `helm lint`,
`terraform validate`) and record the commands and results in the run log; never apply to real
infrastructure from an agent session.
