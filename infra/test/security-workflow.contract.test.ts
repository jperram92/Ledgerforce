import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../..');
function document(path: string): Record<string, unknown> {
  const file = resolve(root, path);
  return existsSync(file) ? (parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
}

describe('approved security workflow contract [T-0095]', () => {
  it('provides pinned scanners for SAST, secrets, inventory and image vulnerabilities', () => {
    const policy = document('infra/security/tools.json');
    const images = policy['images'] as Record<string, string> | undefined;
    expect(images, 'security tool inventory must exist').toBeDefined();
    for (const tool of ['semgrep', 'gitleaks', 'syft', 'grype']) {
      expect(images?.[tool]).toMatch(/^[a-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$/);
    }
  });

  it('runs unprivileged on pull requests with immutable actions and no softened jobs', () => {
    const workflow = document('.github/workflows/security.yml');
    expect(workflow['on'], 'security workflow triggers must exist').toBeDefined();
    expect(workflow['on'], 'security workflow must run on ordinary PRs').toHaveProperty('pull_request');
    expect(workflow['on']).not.toHaveProperty('pull_request_target');
    expect(workflow['permissions']).toEqual({ contents: 'read' });
    const jobs = workflow['jobs'] as Record<string, { permissions?: unknown; steps: Record<string, unknown>[] }>;
    expect(Object.keys(jobs).length).toBeGreaterThan(0);
    for (const job of Object.values(jobs)) {
      expect(job.permissions).toBeUndefined();
      for (const step of job.steps) {
        expect(step['continue-on-error']).toBeUndefined();
        if (step['uses']) expect(step['uses']).toMatch(/^[a-zA-Z0-9/_-]+@[a-f0-9]{40}$/);
      }
    }
  });
});
