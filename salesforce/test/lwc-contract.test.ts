/**
 * Offline contract of the LedgerForce Lightning web components (T-0072, RQ-0045, DL-0218..0222).
 *
 * - The LWC Jest suite really runs: `pnpm test` chains `pnpm test:lwc`, which runs sfdx-lwc-jest
 *   from the SFDX root over every bundle's __tests__, and nothing lets it pass with no tests.
 * - lfAccountSummary (UC-12) is exposed only on Account record pages, on the project API version.
 * - It reads only fields that the LF_Read_Only permission set grants (FLS stays the gate: Lightning
 *   Data Service enforces it at run time, this test keeps the package consistent with it).
 * - It is display-only: no Apex, no record writes, no LedgerForce call, no number conversion.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { all, loadPackage, one, SALESFORCE_ROOT, text, type LoadedPackage } from './metadata.ts';

const API_VERSION = '67.0';
const LWC_DIR = join(SALESFORCE_ROOT, 'force-app', 'main', 'default', 'lwc');
const BUNDLE = 'lfAccountSummary';

let pkg: LoadedPackage;
let source: string;
beforeAll(async () => {
  pkg = await loadPackage(SALESFORCE_ROOT);
  source = await readFile(join(LWC_DIR, BUNDLE, `${BUNDLE}.js`), 'utf8');
});

describe('T-0072: the LWC Jest suite is part of pnpm test', () => {
  it('pnpm test runs test:lwc after Vitest, and test:lwc runs sfdx-lwc-jest from salesforce/', async () => {
    const root = JSON.parse(
      await readFile(join(SALESFORCE_ROOT, '..', 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
    expect(root.scripts['test']).toMatch(/^vitest run .* && pnpm test:lwc$/);
    expect(root.scripts['test:lwc']).toBe('cd salesforce && sfdx-lwc-jest -- --ci');
    // Pinned exactly (DL-0218).
    expect(root.devDependencies['@salesforce/sfdx-lwc-jest']).toMatch(/^\d+\.\d+\.\d+$/);
    for (const script of Object.values(root.scripts)) expect(script).not.toMatch(/passWithNoTests/);
  });

  it('jest.config.cjs runs exactly the LWC __tests__ specs', async () => {
    const config = await readFile(join(SALESFORCE_ROOT, 'jest.config.cjs'), 'utf8');
    expect(config).toContain("require('@salesforce/sfdx-lwc-jest/config')");
    expect(config).toContain("testMatch: ['<rootDir>/force-app/**/lwc/**/__tests__/**/*.test.js']");
    expect(config).not.toMatch(/passWithNoTests|testPathIgnorePatterns/);
  });

  it('every LWC bundle has a Jest spec named after it', async () => {
    const bundles = (await readdir(LWC_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(bundles).toContain(BUNDLE);
    for (const b of bundles) {
      const specs = await readdir(join(LWC_DIR, b, '__tests__'));
      expect(specs, b).toContain(`${b}.test.js`);
    }
  });
});

describe('T-0072: lfAccountSummary bundle metadata', () => {
  it('is exposed on Account record pages only, on the project API version', () => {
    const meta = pkg.lwcBundles.get(BUNDLE);
    if (!meta) throw new Error(`missing ${BUNDLE}.js-meta.xml`);
    expect(text(meta, 'apiVersion')).toBe(API_VERSION);
    expect(text(meta, 'isExposed')).toBe('true');
    expect(text(meta, 'masterLabel')).toMatch(/LedgerForce/);
    const targets = one(meta, 'targets');
    expect(targets && all(targets, 'target').map((t) => t.text)).toEqual(['lightning__RecordPage']);
    const configs = all(meta, 'targetConfig');
    expect(configs.map((c) => c.attributes)).toEqual([{ targets: 'lightning__RecordPage' }]);
    expect(configs.flatMap((c) => all(c, 'object')).map((o) => o.text)).toEqual(['Account']);
  });

  it('every bundle in lwc/ is loaded as LightningComponentBundle metadata', async () => {
    const bundles = (await readdir(LWC_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect([...pkg.lwcBundles.keys()].sort()).toEqual(bundles);
  });
});

describe('T-0072: lfAccountSummary reads only what LF_Read_Only grants, and writes nothing', () => {
  const readOnlyFields = () => {
    const set = pkg.permissionSets.get('LF_Read_Only');
    if (!set) throw new Error('missing LF_Read_Only');
    return new Map(
      all(set, 'fieldPermissions').map((p) => [
        text(p, 'field'),
        { read: text(p, 'readable') === 'true', edit: text(p, 'editable') === 'true' },
      ]),
    );
  };

  it('every LF field the component reads is readable (and not editable) in LF_Read_Only', () => {
    const used = new Set(
      [...source.matchAll(/\b(Account|LF_Invoice__c)\.(LF_\w+__c)\b/g)].map((m) => m[0]),
    );
    // Balance, overdue, last payment, credit status; issue/due date, status, total, amount due.
    expect([...used].sort()).toEqual(
      [
        'Account.LF_Balance_Due__c',
        'Account.LF_Credit_Status__c',
        'Account.LF_Last_Payment_Date__c',
        'Account.LF_Overdue_Amount__c',
        'LF_Invoice__c.LF_Amount_Due__c',
        'LF_Invoice__c.LF_Due_Date__c',
        'LF_Invoice__c.LF_Issue_Date__c',
        'LF_Invoice__c.LF_Status__c',
        'LF_Invoice__c.LF_Total__c',
      ].sort(),
    );
    const granted = readOnlyFields();
    for (const f of used) expect(granted.get(f), f).toEqual({ read: true, edit: false });
  });

  it('reads Account fields through @salesforce/schema imports (deploy-time reference checks)', () => {
    for (const f of [
      'LF_Balance_Due__c',
      'LF_Overdue_Amount__c',
      'LF_Last_Payment_Date__c',
      'LF_Credit_Status__c',
    ]) {
      expect(source).toContain(`'@salesforce/schema/Account.${f}'`);
    }
  });

  it('uses only the read wire adapters: no Apex, no record writes, no outbound calls', () => {
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(
      imports.filter((i) => !i?.startsWith('@salesforce/schema/') && i !== 'lwc').sort(),
    ).toEqual(['lightning/uiRecordApi', 'lightning/uiRelatedListApi']);
    expect(source).toMatch(/import \{ getFieldDisplayValue, getFieldValue, getRecord \} from/);
    expect(source).toMatch(/import \{ getRelatedListRecords \} from/);
    expect(source).not.toMatch(
      /fetch\(|XMLHttpRequest|@salesforce\/apex|updateRecord|createRecord/,
    );
  });

  it('never converts or computes money in the browser', () => {
    expect(source).not.toMatch(/parseFloat|parseInt|Number\(|toFixed|Math\./);
  });
});
