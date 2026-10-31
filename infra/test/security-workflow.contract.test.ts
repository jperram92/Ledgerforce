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
    expect(workflow['on'], 'security workflow must run on ordinary PRs').toHaveProperty(
      'pull_request',
    );
    expect(workflow['on']).not.toHaveProperty('pull_request_target');
    expect(workflow['permissions']).toEqual({ contents: 'read' });
    const jobs = workflow['jobs'] as Record<
      string,
      { permissions?: unknown; steps: Record<string, unknown>[] }
    >;
    expect(Object.keys(jobs).length).toBeGreaterThan(0);
    for (const job of Object.values(jobs)) {
      expect(job.permissions).toBeUndefined();
      for (const step of job.steps) {
        expect(step['continue-on-error']).toBeUndefined();
        if (step['uses']) expect(step['uses']).toMatch(/^[a-zA-Z0-9/_-]+@[a-f0-9]{40}$/);
      }
    }
  });

  it('excuses only past commits in .gitleaksignore, never the working tree (DL-0244)', () => {
    const file = resolve(root, '.gitleaksignore');
    expect(existsSync(file), '.gitleaksignore lists the reviewed historical findings').toBe(true);
    const entries = readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      // <commit sha>:<path>:<rule>:<line> — a bare path:rule:line entry would excuse the tree.
      expect(entry).toMatch(/^[a-f0-9]{40}:[^:\s]+:[a-z0-9-]+:\d+$/);
      expect(entry, 'only the generic rule has reviewed false positives').toContain(
        ':generic-api-key:',
      );
    }
    expect(new Set(entries).size, 'no duplicate entries').toBe(entries.length);
  });

  it('covers every ADR-0043 scan kind, the production audit and each shipped image', () => {
    const file = resolve(root, '.github/workflows/security.yml');
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    for (const kind of ['sast', 'history', 'secrets', 'sbom', 'vulnerabilities']) {
      expect(text, `security workflow must run the ${kind} scan`).toMatch(
        new RegExp(`scripts/security/scan\\.mjs ${kind} `),
      );
    }
    expect(text, 'production dependencies gate at high severity').toContain(
      'pnpm audit --prod --audit-level high',
    );
    expect(text, 'dev dependencies are reported').toContain('pnpm audit --dev --json');
    for (const target of ['api', 'worker', 'setup', 'web']) {
      expect(text, `shipped image ${target} must be inventoried`).toMatch(
        new RegExp(`\\b${target}\\b`),
      );
    }
    expect(text, 'reports are published as ordinary run artifacts').toContain(
      'actions/upload-artifact@',
    );
    for (const forbidden of [
      'continue-on-error',
      'ignore-unfixed',
      '--only-fixed',
      'pull_request_target',
      'latest',
    ]) {
      expect(text, `security workflow must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });
});
