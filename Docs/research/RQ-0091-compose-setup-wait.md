---
id: RQ-0091
status: resolved
task: T-0113
---

# Waiting for one-shot setup containers

CI 40778054881 shows setup exited successfully before compose wait selected it. Selection must include stopped containers and distinguish a Docker command failure from the container exit code.

Primary sources checked 2026-10-29:
- https://docs.docker.com/reference/cli/docker/compose/ps/ documents --all includes stopped containers (default selection is running only).
- https://docs.docker.com/reference/cli/docker/container/wait/ documents blocking until a container stops, then printing its exit code.

Conclusion: resolve exactly one setup ID with compose ps --all --quiet setup, reject missing/ambiguous IDs, then capture docker wait stdout. Treat command failure separately and accept only the printed code 0. Retain nonzero rejection. Redact the same one-time-password line in both success and failure logs. Prove against real stopped success/failure containers and a missing service; no mocked daemon.
