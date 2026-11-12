// ADR-0047: evidence of an existing approval, never an authorization bypass.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitTry } from './git.ts';

const REGISTRY = 'Docs/decisions/golden-approvals.json';
const DECISIONS = 'Docs/decisions/decision-log.md';
const lf = (text: string) => text.replaceAll('\r\n', '\n');

export function approvedGoldenPaths(root: string): { paths: Set<string>; errors: string[] } {
  const paths = new Set<string>();
  const errors: string[] = [];
  if (!existsSync(join(root, REGISTRY))) return { paths, errors };
  try {
    const registry = JSON.parse(readFileSync(join(root, REGISTRY), 'utf8'));
    if (registry?.schemaVersion !== 1 || !Array.isArray(registry.approvals)) {
      throw new Error('expected schemaVersion 1 and approvals array');
    }
    for (const record of registry.approvals) {
      if (!record || typeof record.path !== 'string' ||
          !/^Docs\/accounting\/(?:[\w-]+\/)*[\w.-]+\.md$/.test(record.path) ||
          record.path.split('/').some((part: string) => part === '.' || part === '..') ||
          typeof record.commit !== 'string' || !/^[a-f0-9]{40}$/.test(record.commit) ||
          !Array.isArray(record.decisions) || record.decisions.length === 0 ||
          !record.decisions.every((id: unknown) => typeof id === 'string' && /^DL-\d{4}$/.test(id))) {
        throw new Error('invalid approval record: expected protected path, full commit and decision IDs');
      }
      if (paths.has(record.path)) throw new Error(`duplicate approval path: ${record.path}`);
      if (gitTry(root, ['cat-file', '-t', record.commit]).out !== 'commit' ||
          gitTry(root, ['merge-base', '--is-ancestor', record.commit, 'HEAD']).code !== 0) {
        throw new Error(`${record.path}: approval commit is not an available ancestor of HEAD`);
      }
      // Do not use gitTry's trimmed output: trailing whitespace is protected content too.
      const show = (path: string) => execFileSync('git', ['show', `${record.commit}:${path}`], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      const evidence = show(DECISIONS);
      const previous = gitTry(root, ['show', `${record.commit}^:${DECISIONS}`]);
      if (previous.code !== 0) throw new Error(`${record.path}: parent decision evidence is unavailable`);
      const previousEvidence = previous.out;
      let newDecision = false;
      for (const id of record.decisions) {
        if (!new RegExp(`^### ${id}(?:\\s|$)`, 'm').test(evidence)) {
          throw new Error(`${record.path}: decision ${id} absent from approval commit`);
        }
        if (!new RegExp(`^### ${id}(?:\\s|$)`, 'm').test(previousEvidence)) newDecision = true;
      }
      if (!newDecision) throw new Error(`${record.path}: approval commit must introduce a cited decision; earlier decisions cannot be recycled`);
      const expected = show(record.path);
      if (!existsSync(join(root, record.path)) || lf(readFileSync(join(root, record.path), 'utf8')) !== lf(expected)) {
        throw new Error(`${record.path}: content differs from approved snapshot ${record.commit}`);
      }
      paths.add(record.path);
    }
  } catch (error) {
    errors.push(`${REGISTRY}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { paths, errors };
}
