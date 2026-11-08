/**
 * Offline contract of the LedgerForce SFDX unlocked package (T-0062, RQ-0022, DL-0094..0097).
 * These tests are the expected result for the metadata in salesforce/force-app: the connector
 * (T-0067, upsert by LF_Id__c) and the LWC (T-0072) depend on every name, type and flag below.
 *
 * - SS-PLAT-45: project, objects, fields, external IDs, platform event, API version, file layout.
 * - SS-UC12-02 (metadata part, offline): mirror data is read-only for sales users — the read-only
 *   permission set never grants edit, and validation rules block every non-integration write.
 *   The org part (a real save blocked, Apex test) needs a scratch org (Dev Hub, RQ-0022).
 * - SS-PLAT-46: permission sets grant exactly what each role needs (least privilege).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  all,
  loadPackage,
  one,
  SALESFORCE_ROOT,
  text,
  type FieldMeta,
  type LoadedPackage,
} from './metadata.ts';

const API_VERSION = '67.0';
const METADATA_NS = 'http://soap.sforce.com/2006/04/metadata';
const INTEGRATION_PERMISSION = 'LF_Integration_Write';

type FieldSpec =
  | { type: 'Text'; length: number; externalId?: true }
  | { type: 'Currency'; precision: 18; scale: 2 }
  | { type: 'Number'; precision: number; scale: 0 }
  | { type: 'Date' }
  | { type: 'Url' }
  | { type: 'Lookup'; referenceTo: string; relationshipName: string };

/** The data contract (DL-0096). Exact: no field may be missing and no LF field may be extra. */
const FIELDS: Record<string, Record<string, FieldSpec>> = {
  LF_Invoice__c: {
    LF_Id__c: { type: 'Text', length: 36, externalId: true },
    LF_Status__c: { type: 'Text', length: 40 },
    LF_Issue_Date__c: { type: 'Date' },
    LF_Due_Date__c: { type: 'Date' },
    LF_Total__c: { type: 'Currency', precision: 18, scale: 2 },
    LF_Amount_Due__c: { type: 'Currency', precision: 18, scale: 2 },
    LF_Amount_Credited__c: { type: 'Currency', precision: 18, scale: 2 },
    LF_Days_Overdue__c: { type: 'Number', precision: 6, scale: 0 },
    LF_Last_Payment_Date__c: { type: 'Date' },
    LF_PDF_Link__c: { type: 'Url' },
    LF_Payment_Link__c: { type: 'Url' },
    LF_Account__c: { type: 'Lookup', referenceTo: 'Account', relationshipName: 'LF_Invoices' },
    LF_Opportunity__c: {
      type: 'Lookup',
      referenceTo: 'Opportunity',
      relationshipName: 'LF_Invoices',
    },
  },
  LF_Payment__c: {
    LF_Id__c: { type: 'Text', length: 36, externalId: true },
    LF_Payment_Date__c: { type: 'Date' },
    LF_Amount__c: { type: 'Currency', precision: 18, scale: 2 },
    LF_Method__c: { type: 'Text', length: 40 },
    LF_Reference__c: { type: 'Text', length: 255 },
    LF_Account__c: { type: 'Lookup', referenceTo: 'Account', relationshipName: 'LF_Payments' },
    LF_Invoice__c: {
      type: 'Lookup',
      referenceTo: 'LF_Invoice__c',
      relationshipName: 'LF_Payments',
    },
  },
  Account: {
    LF_Balance_Due__c: { type: 'Currency', precision: 18, scale: 2 },
    LF_Overdue_Amount__c: { type: 'Currency', precision: 18, scale: 2 },
    LF_Credit_Status__c: { type: 'Text', length: 40 },
    LF_Last_Payment_Date__c: { type: 'Date' },
  },
  Opportunity: {
    LF_Invoice_Status__c: { type: 'Text', length: 40 },
    LF_Amount_Invoiced__c: { type: 'Currency', precision: 18, scale: 2 },
    LF_Amount_Paid__c: { type: 'Currency', precision: 18, scale: 2 },
  },
  LF_Billing_Request__e: {
    LF_Request_Id__c: { type: 'Text', length: 36 },
    LF_Request_Type__c: { type: 'Text', length: 40 },
    LF_Record_Id__c: { type: 'Text', length: 18 },
    LF_Requested_By__c: { type: 'Text', length: 18 },
  },
};

const MIRRORS = ['LF_Invoice__c', 'LF_Payment__c'] as const;
const STANDARD = ['Account', 'Opportunity'] as const;
const EVENT = 'LF_Billing_Request__e';
/** Every field that carries field-level security (all LF fields except event fields). */
const FLS_FIELDS = [...MIRRORS, ...STANDARD].flatMap((o) =>
  Object.keys(FIELDS[o] ?? {}).map((f) => `${o}.${f}`),
);

let pkg: LoadedPackage;
beforeAll(async () => {
  pkg = await loadPackage(SALESFORCE_ROOT);
});

const field = (object: string, name: string): FieldMeta => {
  const f = pkg.objects.get(object)?.fields.get(name);
  if (!f) throw new Error(`missing field ${object}.${name}`);
  return f;
};

/** Object permissions of a permission set as { object: 'CRED-VM' flags }. */
const objectPermissions = (setName: string) => {
  const set = pkg.permissionSets.get(setName);
  if (!set) throw new Error(`missing permission set ${setName}`);
  const flags = (el: (typeof set.children)[number]) =>
    (
      [
        ['allowCreate', 'C'],
        ['allowRead', 'R'],
        ['allowEdit', 'E'],
        ['allowDelete', 'D'],
        ['viewAllRecords', 'V'],
        ['modifyAllRecords', 'M'],
      ] as const
    )
      .filter(([tag]) => text(el, tag) === 'true')
      .map(([, letter]) => letter)
      .join('');
  return Object.fromEntries(
    all(set, 'objectPermissions').map((p) => [text(p, 'object'), flags(p)]),
  );
};

const fieldPermissions = (setName: string) => {
  const set = pkg.permissionSets.get(setName);
  if (!set) throw new Error(`missing permission set ${setName}`);
  return Object.fromEntries(
    all(set, 'fieldPermissions').map((p) => [
      text(p, 'field'),
      `${text(p, 'readable') === 'true' ? 'R' : ''}${text(p, 'editable') === 'true' ? 'E' : ''}`,
    ]),
  );
};

const enabledNames = (setName: string, element: string) => {
  const set = pkg.permissionSets.get(setName);
  if (!set) throw new Error(`missing permission set ${setName}`);
  return all(set, element)
    .filter((p) => text(p, 'enabled') === 'true')
    .map((p) => text(p, 'name'))
    .sort();
};

describe('SS-PLAT-45: SFDX package metadata contract (offline)', () => {
  it('is one unlocked-package directory on API 67.0 with no namespace', async () => {
    const project = JSON.parse(
      await readFile(join(SALESFORCE_ROOT, 'sfdx-project.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(project['sourceApiVersion']).toBe(API_VERSION);
    expect(project['namespace']).toBe('');
    expect(project['packageDirectories']).toEqual([
      {
        path: 'force-app',
        default: true,
        package: 'LedgerForce',
        versionName: expect.any(String),
        versionNumber: expect.stringMatching(/^\d+\.\d+\.\d+\.NEXT$/),
        definitionFile: 'config/project-scratch-def.json',
      },
    ]);
  });

  it('every metadata file is strict XML in the metadata namespace, named after its component', () => {
    expect(pkg.files.length).toBeGreaterThan(0);
    for (const f of pkg.files) {
      expect(f.root.attributes, f.path).toEqual({ xmlns: METADATA_NS });
      expect(f.root.name, f.path).toBe(f.expectedRoot);
      const fullName = one(f.root, 'fullName');
      if (fullName) expect(fullName.text, f.path).toBe(f.componentName);
    }
  });

  it('every apiVersion in the project is the project API version', () => {
    const versions = pkg.files.flatMap((f) => all(f.root, 'apiVersion').map((v) => v.text));
    expect(versions.length).toBeGreaterThan(0); // the Apex test class carries one
    expect(new Set(versions)).toEqual(new Set([API_VERSION]));
  });

  it('declares exactly the LF fields of the contract on each object', () => {
    for (const [object, spec] of Object.entries(FIELDS)) {
      const actual = [...(pkg.objects.get(object)?.fields.keys() ?? [])].sort();
      expect(actual, object).toEqual(Object.keys(spec).sort());
    }
    const lfObjects = [...pkg.objects.keys()].filter((o) => o.startsWith('LF_'));
    expect(lfObjects.sort()).toEqual([EVENT, ...MIRRORS].sort());
  });

  it.each(Object.entries(FIELDS).flatMap(([o, s]) => Object.entries(s).map(([f, x]) => [o, f, x])))(
    '%s.%s has the contracted type and flags',
    (object, name, spec) => {
      const f = field(object as string, name as string).root;
      const s = spec as FieldSpec;
      expect(text(f, 'type')).toBe(s.type);
      expect(text(f, 'label')).not.toBe('');
      // Required fields cannot carry permission-set FLS (RQ-0022 F4), so none is required.
      expect(text(f, 'required') ?? 'false').toBe('false');
      switch (s.type) {
        case 'Text':
          expect(text(f, 'length')).toBe(String(s.length));
          if (s.externalId) {
            expect(text(f, 'externalId')).toBe('true');
            expect(text(f, 'unique')).toBe('true');
            expect(text(f, 'caseSensitive')).toBe('false');
          } else {
            expect(text(f, 'externalId') ?? 'false').toBe('false');
          }
          break;
        case 'Currency':
        case 'Number':
          expect([text(f, 'precision'), text(f, 'scale')]).toEqual([
            String(s.precision),
            String(s.scale),
          ]);
          break;
        case 'Lookup':
          expect(text(f, 'referenceTo')).toBe(s.referenceTo);
          expect(text(f, 'relationshipName')).toBe(s.relationshipName);
          // Salesforce owns Accounts/Opportunities (ADR-0006): never block their deletion.
          expect(text(f, 'deleteConstraint')).toBe('SetNull');
          break;
        default:
          break;
      }
    },
  );

  it('mirror objects are deployed, public read-only, named by the document number', () => {
    for (const o of MIRRORS) {
      const meta = pkg.objects.get(o)?.meta;
      if (!meta) throw new Error(`missing ${o}.object-meta.xml`);
      expect(text(meta, 'deploymentStatus'), o).toBe('Deployed');
      expect(text(meta, 'sharingModel'), o).toBe('Read');
      expect(text(meta, 'externalSharingModel'), o).toBe('Read');
      const nameField = one(meta, 'nameField');
      expect(nameField && text(nameField, 'type'), o).toBe('Text');
    }
  });

  it('LF_Billing_Request__e is a high-volume event published after commit', () => {
    const meta = pkg.objects.get(EVENT)?.meta;
    if (!meta) throw new Error(`missing ${EVENT}.object-meta.xml`);
    expect(text(meta, 'eventType')).toBe('HighVolume');
    expect(text(meta, 'publishBehavior')).toBe('PublishAfterCommit');
    expect(text(meta, 'deploymentStatus')).toBe('Deployed');
  });

  it('standard objects get only fields and rules (no object definition is overwritten)', () => {
    for (const o of STANDARD) expect(pkg.objects.get(o)?.meta, o).toBeUndefined();
  });

  it('holds no credentials and keeps CLI auth folders out of git', async () => {
    const forbidden =
      /BEGIN [A-Z ]*PRIVATE KEY|force:\/\/|refresh_token|client_secret|consumerSecret|sfdxAuthUrl/i;
    for (const f of pkg.allFiles) expect(forbidden.test(f.content), f.path).toBe(false);
    const ignore = await readFile(join(SALESFORCE_ROOT, '.gitignore'), 'utf8');
    expect(ignore.split('\n')).toEqual(expect.arrayContaining(['.sf/', '.sfdx/']));
  });
});

describe('SS-UC12-02: Mirror fields are read-only for sales users (metadata part, offline)', () => {
  it('the read-only permission set reads the mirrors and never edits anything', () => {
    expect(objectPermissions('LF_Read_Only')).toEqual({ LF_Invoice__c: 'R', LF_Payment__c: 'R' });
    expect(fieldPermissions('LF_Read_Only')).toEqual(
      Object.fromEntries(FLS_FIELDS.map((f) => [f, 'R'])),
    );
    expect(enabledNames('LF_Read_Only', 'customPermissions')).toEqual([]);
    expect(enabledNames('LF_Read_Only', 'userPermissions')).toEqual([]);
  });

  it.each(MIRRORS)('%s rejects every insert and update without the integration permission', (o) => {
    const rules = pkg.objects.get(o)?.validationRules;
    const rule = rules?.get('LF_Mirror_Read_Only');
    if (!rule) throw new Error(`missing ${o} LF_Mirror_Read_Only`);
    expect(text(rule.root, 'active')).toBe('true');
    expect(squash(text(rule.root, 'errorConditionFormula'))).toBe(
      `NOT($Permission.${INTEGRATION_PERMISSION})`,
    );
    expect(text(rule.root, 'errorMessage')).toMatch(/LedgerForce/);
  });

  it.each(STANDARD)(
    '%s rejects a change to any LF field without the integration permission',
    (o) => {
      const rule = pkg.objects.get(o)?.validationRules.get('LF_Fields_Read_Only');
      if (!rule) throw new Error(`missing ${o} LF_Fields_Read_Only`);
      expect(text(rule.root, 'active')).toBe('true');
      const formula = squash(text(rule.root, 'errorConditionFormula'));
      expect(formula.startsWith(`AND(NOT($Permission.${INTEGRATION_PERMISSION}),OR(`)).toBe(true);
      for (const f of Object.keys(FIELDS[o] ?? {})) {
        expect(formula, f).toContain(`ISCHANGED(${f})`);
        expect(formula, f).toContain(`AND(ISNEW(),NOT(ISBLANK(${f})))`);
      }
      // Exactly one clause pair per contract field — no stray references.
      const referenced = new Set(formula.match(/LF_[A-Za-z_]+__c/g));
      expect([...referenced].sort()).toEqual(Object.keys(FIELDS[o] ?? {}).sort());
    },
  );

  it('an Apex test for the in-org half exists (runs only in a scratch org)', () => {
    const cls = pkg.allFiles.find((f) => f.path.endsWith('LFReadOnlyMirrorTest.cls'));
    expect(cls?.content).toMatch(/SS-UC12-02/);
    expect(cls?.content).toMatch(/@IsTest/);
  });
});

describe('SS-PLAT-46: permission sets grant least privilege; only the integration user writes', () => {
  it('the integration user creates/edits mirrors and LF fields, reads events, no deletes', () => {
    expect(objectPermissions('LF_Integration_User')).toEqual({
      LF_Invoice__c: 'CRE',
      LF_Payment__c: 'CRE',
      Account: 'RE',
      Opportunity: 'RE',
      [EVENT]: 'R',
    });
    expect(fieldPermissions('LF_Integration_User')).toEqual(
      Object.fromEntries(FLS_FIELDS.map((f) => [f, 'RE'])),
    );
    expect(enabledNames('LF_Integration_User', 'customPermissions')).toEqual([
      INTEGRATION_PERMISSION,
    ]);
    expect(enabledNames('LF_Integration_User', 'userPermissions')).toEqual(['ApiEnabled']);
  });

  it('the billing requester may only publish the billing-request event', () => {
    expect(objectPermissions('LF_Billing_Requester')).toEqual({ [EVENT]: 'C' });
    expect(fieldPermissions('LF_Billing_Requester')).toEqual({});
    expect(enabledNames('LF_Billing_Requester', 'customPermissions')).toEqual([]);
    expect(enabledNames('LF_Billing_Requester', 'userPermissions')).toEqual([]);
  });

  it('there are exactly three permission sets and one custom permission', () => {
    expect([...pkg.permissionSets.keys()].sort()).toEqual([
      'LF_Billing_Requester',
      'LF_Integration_User',
      'LF_Read_Only',
    ]);
    expect([...pkg.customPermissions]).toEqual([INTEGRATION_PERMISSION]);
  });

  it('no permission set needs activation or a licence that would stop assignment', () => {
    for (const [name, set] of pkg.permissionSets) {
      expect(text(set, 'hasActivationRequired'), name).toBe('false');
      expect(one(set, 'license'), name).toBeUndefined();
    }
  });
});

/** Formula text without whitespace, for structural comparison. */
function squash(formula: string | undefined): string {
  return (formula ?? '').replace(/\s+/g, '');
}
