// ADR-0043: actual pinned scanners; tool errors and missing/malformed output fail closed.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const { images } = JSON.parse(readFileSync(join(root, 'infra/security/tools.json'), 'utf8'));
const [kind, input, output, ...options] = process.argv.slice(2);
// DAST (ADR-0044) scans a running origin: its input is an http(s) URL, not a path.
const dastUrl = kind === 'dast' ? parseHttpUrl(input) : null;
const target = kind === 'dast' ? root : input && resolve(input);
const out = output && resolve(output);
if (kind === 'dast' && !dastUrl) {
  console.error('security: dast needs an http(s) URL to scan');
  process.exit(2);
}
if (!target || !out || !existsSync(target)) {
  console.error('security: supply scan kind, existing input and output directory');
  process.exit(2);
}
function parseHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
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
// Scanner images are minimal and their /tmp is not writable by an unprivileged user, yet Syft
// unpacks image archives and Grype stages database downloads there. Every container gets this
// caller-owned scratch directory as /tmp (on disk, not tmpfs, so large images fit); removed at exit.
const scratch = mkdtempSync(join(tmpdir(), 'lf-security-'));

function docker(
  tool,
  args,
  { network = false, source = true, extras = [], timeout = 240_000, imageUser = false } = {},
) {
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      // Run as the calling user: with every capability dropped, container root cannot write into
      // an output directory owned by another user (the GitHub runner is uid 1001). HOME=/tmp gives
      // the tools a writable home for their caches.
      // ZAP (imageUser) instead runs as its image's own unprivileged user with its own home and
      // /tmp, where it keeps its state; it is given only a writable work directory (see dast).
      ...(imageUser
        ? []
        : [
            ...(typeof process.getuid === 'function'
              ? ['--user', `${process.getuid()}:${process.getgid()}`]
              : []),
            '--env',
            'HOME=/tmp',
            '--env',
            'TMPDIR=/tmp',
            '--mount',
            `type=bind,source=${scratch},target=/tmp`,
          ]),
      ...(network ? [] : ['--network=none']),
      ...(source ? mounts : []),
      ...extras,
      images[tool],
      ...args,
    ],
    { encoding: 'utf8', timeout, maxBuffer: 20 * 1024 * 1024 },
  );
  if (result.error || result.signal)
    throw new Error(`scanner ${tool} failed to execute: ${result.error?.message || result.signal}`);
  // ZAP reports start-up failures on stdout; other scanners' stdout is never echoed (ADR-0043).
  lastStderr = imageUser
    ? [result.stdout, result.stderr].filter(Boolean).join('\n')
    : result.stderr || '';
  return result;
}
let lastStderr = '';
/** The report names the scanned site (ZAP lists every site it reached in `site[]`). */
function dastSeenTarget(report, url) {
  return report.site.some((site) => {
    const name = String(site['@name'] || '');
    return name === url.origin || name.startsWith(url.origin);
  });
}
function json(name) {
  const file = join(out, name);
  if (!existsSync(file)) {
    // A missing report is a tool failure: show the tool's own diagnostics (tail only). Secret
    // scans run with --redact=100, so their diagnostics never carry a finding's value.
    throw new Error(`scanner did not produce ${name}${stderrTail()}`);
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // An empty or truncated report is as much a tool failure as a missing one.
    throw new Error(`scanner wrote an empty or invalid ${name}${stderrTail()}`);
  }
}
function stderrTail() {
  const tail = lastStderr.trim().split('\n').slice(-20).join('\n');
  return tail ? `\n${tail}` : '';
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
    const findings = json(reportName);
    if (!Array.isArray(findings)) throw new Error('invalid secret report');
    // Where each finding is (never its value: the report is redacted) so a failing job is readable.
    for (const f of findings)
      console.log(`security: finding ${f.RuleID} ${f.File}:${f.StartLine} ${f.Commit || '(tree)'}`);
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
    lastStderr = status.stderr || '';
    if (status.status !== 0)
      throw new Error(`cannot record vulnerability DB metadata${stderrTail()}`);
    try {
      JSON.parse(status.stdout);
    } catch {
      throw new Error(`vulnerability DB metadata is not JSON${stderrTail()}`);
    }
    writeFileSync(join(out, 'grype-db.json'), status.stdout);
    result = docker(
      'grype',
      [`sbom:${inputPath}`, '--fail-on', 'high', '-o', 'json', '--file', '/out/grype.json'],
      { extras: [...extras, '-e', 'GRYPE_DB_AUTO_UPDATE=false'] },
    );
    reportName = 'grype.json';
    const { matches } = json(reportName);
    if (!Array.isArray(matches)) throw new Error('invalid vulnerability report');
    // Summarise every high/critical match (what fails the gate) and count the rest, so a failing
    // job says what to remediate without downloading the artifact.
    const counts = {};
    for (const m of matches) {
      const severity = m.vulnerability?.severity || 'Unknown';
      counts[severity] = (counts[severity] || 0) + 1;
      if (['High', 'Critical'].includes(severity)) {
        const fixed = m.vulnerability?.fix?.versions?.join(', ') || 'no fix';
        console.log(
          `security: vulnerability ${m.vulnerability.id} ${severity} ${m.artifact?.name}@${m.artifact?.version} (${m.artifact?.type}) fixed in: ${fixed}`,
        );
      }
    }
    console.log(`security: vulnerability counts ${JSON.stringify(counts)}`);
  } else if (kind === 'dast') {
    // ADR-0044: passive baseline only (spider + passive rules, no attacks). The container shares
    // the host network so it reaches the started stack (published on 127.0.0.1); a *.localhost
    // name resolves to the host loopback. Reports go to the output directory as /zap/wrk.
    // The work directory must be writable by the image's zap user (ZAP docker documentation).
    chmodSync(out, 0o777);
    const extras = ['--network=host', '--mount', `type=bind,source=${out},target=/zap/wrk`];
    if (dastUrl.hostname.endsWith('.localhost')) {
      extras.push(`--add-host=${dastUrl.hostname}:127.0.0.1`);
    }
    result = docker(
      'zap',
      [
        'zap-baseline.py',
        '-t',
        dastUrl.href,
        '-I', // warnings alone do not fail the scan; the gate below decides on High alerts
        '-m',
        '1', // spider minutes
        '-T',
        '10', // overall cap, minutes
        '-J',
        'zap.json',
        '-r',
        'zap.html',
      ],
      { network: true, source: false, extras, timeout: 900_000, imageUser: true },
    );
    // zap-baseline.py exit 3 = scanner error (e.g. target unreachable): fail closed.
    if (result.status === 3 || result.status === null) {
      throw new Error(`ZAP baseline failed (exit ${result.status})${stderrTail()}`);
    }
    reportName = 'zap.json';
    const report = json(reportName);
    if (!Array.isArray(report.site)) throw new Error('invalid DAST report');
    const alerts = report.site.flatMap((site) => (Array.isArray(site.alerts) ? site.alerts : []));
    // ZAP riskcode: 0 informational, 1 low, 2 medium, 3 high.
    const names = { 0: 'Informational', 1: 'Low', 2: 'Medium', 3: 'High' };
    const counts = {};
    let high = 0;
    for (const a of alerts) {
      const risk = names[a.riskcode] || 'Unknown';
      counts[risk] = (counts[risk] || 0) + 1;
      if (a.riskcode === '3') {
        high += 1;
        const n = Array.isArray(a.instances) ? a.instances.length : 0;
        console.log(`security: dast High ${a.pluginid} ${a.alert} (${n} URL(s))`);
      }
    }
    if (!dastSeenTarget(report, dastUrl)) {
      throw new Error(`ZAP did not reach ${dastUrl.origin}${stderrTail()}`);
    }
    console.log(`security: dast counts ${JSON.stringify(counts)}`);
    // The gate is the report, not ZAP's own exit code (which -I relaxes): any High fails.
    result = { ...result, status: high > 0 ? 1 : 0 };
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
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
