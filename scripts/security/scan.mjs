// ADR-0043: actual pinned scanners; tool errors and missing/malformed output fail closed.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const { images } = JSON.parse(readFileSync(join(root, 'infra/security/tools.json'), 'utf8'));
const [kind, input, output, ...options] = process.argv.slice(2);
const target = input && resolve(input);
const out = output && resolve(output);
if (!target || !out || !existsSync(target)) {
  console.error('security: supply scan kind, existing input and output directory');
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const cache = resolve(process.env.LF_SECURITY_CACHE || join(root, '.tmp/security-cache'));
mkdirSync(cache, { recursive: true });
const inputDirectory = statSync(target).isDirectory();
const inputPath = inputDirectory ? '/src' : `/src/${basename(target)}`;
const mounts = [
  '--mount',
  `type=bind,source=${inputDirectory ? target : dirname(target)},target=/src,readonly`,
  '--mount',
  `type=bind,source=${out},target=/out`,
];

function docker(tool, args, { network = false, source = true, extras = [] } = {}) {
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      ...(network ? [] : ['--network=none']),
      ...(source ? mounts : []),
      ...extras,
      images[tool],
      ...args,
    ],
    { encoding: 'utf8', timeout: 240_000, maxBuffer: 20 * 1024 * 1024 },
  );
  if (result.error || result.signal)
    throw new Error(`scanner ${tool} failed to execute: ${result.error?.message || result.signal}`);
  return result;
}
function json(name) {
  const file = join(out, name);
  if (!existsSync(file)) throw new Error(`scanner did not produce ${name}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

try {
  let result;
  let reportName;
  if (kind === 'sast') {
    const rulesIndex = options.indexOf('--rules');
    const rules =
      rulesIndex < 0 ? join(root, 'infra/security/semgrep.yml') : resolve(options[rulesIndex + 1]);
    result = docker(
      'semgrep',
      [
        'semgrep',
        'scan',
        '--config',
        '/rules.yml',
        '--metrics=off',
        '--disable-version-check',
        '--error',
        '--strict',
        '--json',
        '--output',
        '/out/semgrep.json',
        inputPath,
      ],
      {
        extras: [
          '--mount',
          `type=bind,source=${rules},target=/rules.yml,readonly`,
          '-e',
          'SEMGREP_SEND_METRICS=off',
        ],
      },
    );
    reportName = 'semgrep.json';
    if (!Array.isArray(json(reportName).results)) throw new Error('invalid SAST report');
  } else if (kind === 'secrets' || kind === 'history') {
    result = docker('gitleaks', [
      kind === 'history' ? 'git' : 'dir',
      inputPath,
      '--redact=100',
      '--no-banner',
      '--exit-code=1',
      '--report-format=json',
      '--report-path=/out/gitleaks.json',
      // Inline `gitleaks:allow` comments are never honoured (ADR-0043 rule 5: no self-service
      // suppressions). Only history scans read the repository's .gitleaksignore, whose entries the
      // workflow contract limits to commit-scoped fingerprints of past commits (DL-0244); the
      // working tree must be clean, so tree scans read an ignore path that never exists.
      '--ignore-gitleaks-allow',
      `--gitleaks-ignore-path=${kind === 'history' ? inputPath : '/nonexistent-gitleaksignore'}`,
    ]);
    reportName = 'gitleaks.json';
    if (!Array.isArray(json(reportName))) throw new Error('invalid secret report');
  } else if (kind === 'sbom') {
    const source = inputDirectory ? `dir:${inputPath}` : `docker-archive:${inputPath}`;
    result = docker('syft', [source, '-o', 'cyclonedx-json=/out/sbom.cdx.json']);
    reportName = 'sbom.cdx.json';
    const inventory = json(reportName);
    if (inventory.bomFormat !== 'CycloneDX' || !Array.isArray(inventory.components))
      throw new Error('invalid SBOM');
  } else if (kind === 'vulnerabilities') {
    const extras = [
      '--mount',
      `type=bind,source=${cache},target=/cache`,
      '-e',
      'GRYPE_DB_CACHE_DIR=/cache',
    ];
    // Download only public advisory data, with no source mounts. Scan offline afterwards.
    const update = docker('grype', ['db', 'update'], { network: true, source: false, extras });
    if (update.status !== 0) throw new Error(`vulnerability DB update failed: ${update.stderr}`);
    const status = docker('grype', ['db', 'status', '-o', 'json'], { source: false, extras });
    if (status.status !== 0) throw new Error('cannot record vulnerability DB metadata');
    JSON.parse(status.stdout);
    writeFileSync(join(out, 'grype-db.json'), status.stdout);
    result = docker(
      'grype',
      [`sbom:${inputPath}`, '--fail-on', 'high', '-o', 'json', '--file', '/out/grype.json'],
      { extras: [...extras, '-e', 'GRYPE_DB_AUTO_UPDATE=false'] },
    );
    reportName = 'grype.json';
    if (!Array.isArray(json(reportName).matches)) throw new Error('invalid vulnerability report');
  } else {
    throw new Error(`unknown scan kind ${kind}`);
  }
  writeFileSync(
    join(out, `${kind}-metadata.json`),
    JSON.stringify(
      {
        kind,
        images,
        report: reportName,
        exitCode: result.status,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  // Never echo scanner output: reports are validated artifacts, and secret scans redact them.
  console.log(`security: ${kind}: ${result.status === 0 ? 'PASS' : 'FAIL'} (${reportName})`);
  process.exitCode = result.status === 0 ? 0 : 1;
} catch (error) {
  console.error(`security: ${error.message}`);
  process.exitCode = 2;
}
