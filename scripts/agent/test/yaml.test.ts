import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml, formatScalar } from '../lib/yaml.ts';

test('scalars: strings, numbers, booleans, null', () => {
  const v = parseYaml(`a: hello world
b: 42
c: -3.5
d: true
e: false
f: null
g: ~
h:
i: "quoted # not a comment"
j: 'single ''quoted'''
k: 2026-11-02T04:30:00Z
l: T-0042
m: "esc\\n\\"x\\""
`);
  assert.deepEqual(v, {
    a: 'hello world', b: 42, c: -3.5, d: true, e: false, f: null, g: null, h: null,
    i: 'quoted # not a comment', j: "single 'quoted'", k: '2026-11-02T04:30:00Z', l: 'T-0042',
    m: 'esc\n"x"',
  });
});

test('comments: full-line and trailing, but not inside quotes or words', () => {
  const v = parseYaml(`# header
a: 1   # trailing
b: "x # y"   # real comment
c: a#b
  # indented comment line
d: [x, y] # after flow
`);
  assert.deepEqual(v, { a: 1, b: 'x # y', c: 'a#b', d: ['x', 'y'] });
});

test('nested maps and block lists', () => {
  const v = parseYaml(`top:
  inner:
    deep: 1
  other: two
list:
  - one
  - "two"
  - 3
same_indent_list:
- a
- b
`);
  assert.deepEqual(v, {
    top: { inner: { deep: 1 }, other: 'two' },
    list: ['one', 'two', 3],
    same_indent_list: ['a', 'b'],
  });
});

test('list of maps (providers shape)', () => {
  const v = parseYaml(`providers:
  - id: claude
    cli: "claude -p"   # headless
    role: [build, review]
  - id: codex
    cli: "codex exec"
    args: ["--sandbox", workspace-write]
`);
  assert.deepEqual(v, {
    providers: [
      { id: 'claude', cli: 'claude -p', role: ['build', 'review'] },
      { id: 'codex', cli: 'codex exec', args: ['--sandbox', 'workspace-write'] },
    ],
  });
});

test('inline flow maps and lists, nested and empty', () => {
  const v = parseYaml(`budgets:
  claude: { daily_usd: 40 }
  mixed: {a: [1, 2], b: {c: "d, e"}, f: }
empty_list: []
empty_map: {}
gates: [adr:accounting, adr:security, release]
`);
  assert.deepEqual(v, {
    budgets: { claude: { daily_usd: 40 }, mixed: { a: [1, 2], b: { c: 'd, e' }, f: null } },
    empty_list: [],
    empty_map: {},
    gates: ['adr:accounting', 'adr:security', 'release'],
  });
});

test('literal block scalar', () => {
  const v = parseYaml(`note: |
  line one
  line two
after: x
`);
  assert.deepEqual(v, { note: 'line one\nline two\n', after: 'x' });
});

test('errors carry a line number', () => {
  assert.throws(() => parseYaml('a: 1\n  b: 2\n'), /line 2/);
  assert.throws(() => parseYaml('a: [1, 2\n'), /line 1/);
  assert.throws(() => parseYaml('a:\n\t- x\n'), /tab/i);
});

test('parses the real .agent/config.yaml', () => {
  const text = readFileSync(join(import.meta.dirname, '../../../.agent/config.yaml'), 'utf8');
  const cfg = parseYaml(text) as any;
  assert.equal(cfg.providers[0].id, 'claude');
  assert.equal(cfg.providers[1].cli, 'codex exec');
  assert.deepEqual(cfg.failover_order, ['claude', 'codex']);
  assert.equal(cfg.lease_minutes, 45);
  assert.equal(cfg.budgets.claude.daily_usd, 40);
  assert.ok(cfg.failure_patterns.quota.includes('insufficient_quota'));
  assert.equal(cfg.paths.state, '.agent/state.json');
});

test('formatScalar round-trips through parseYaml', () => {
  const values: unknown[] = ['claude', '2026-11-02T04:30:00Z', 'has: colon', 'has # hash', '', 'true', '42',
    'null', 42, 1.5, true, null, ['T-0001', 'T-0002'], [], 'quote"d', "it's", '7f3c2e1', 'a, b'];
  for (const v of values) {
    const text = `k: ${formatScalar(v)}\n`;
    assert.deepEqual((parseYaml(text) as any).k, v, `round-trip of ${JSON.stringify(v)} via ${text}`);
  }
});
