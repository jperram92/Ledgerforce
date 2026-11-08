/**
 * Test-only reader of the SFDX package's field metadata (salesforce/force-app, T-0062). The fake
 * REST server and the write-back contract tests use it so the mapping can only name fields the
 * package really deploys, with their real types and sizes (RQ-0040 S11).
 */
import { readdirSync, readFileSync } from 'node:fs';

export const OBJECTS_DIR = new URL(
  '../../../../../salesforce/force-app/main/default/objects/',
  import.meta.url,
);

export interface FieldMeta {
  name: string;
  type: string;
  length: number | null;
  precision: number | null;
  scale: number | null;
  externalId: boolean;
  referenceTo: string | null;
}

const tag = (xml: string, name: string): string | null =>
  new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? null;
const int = (v: string | null): number | null => (v === null ? null : Number.parseInt(v, 10));

/** Fields per object, from `objects/<Object>/fields/*.field-meta.xml`. */
export function packageFields(): Map<string, Map<string, FieldMeta>> {
  const out = new Map<string, Map<string, FieldMeta>>();
  for (const object of readdirSync(OBJECTS_DIR)) {
    const fields = new Map<string, FieldMeta>();
    let files: string[];
    try {
      files = readdirSync(new URL(`${object}/fields/`, OBJECTS_DIR));
    } catch {
      files = []; // e.g. an object without custom fields
    }
    for (const f of files.filter((n) => n.endsWith('.field-meta.xml'))) {
      const xml = readFileSync(new URL(`${object}/fields/${f}`, OBJECTS_DIR), 'utf8');
      const name = tag(xml, 'fullName') ?? f.replace('.field-meta.xml', '');
      fields.set(name, {
        name,
        type: tag(xml, 'type') ?? 'Unknown',
        length: int(tag(xml, 'length')),
        precision: int(tag(xml, 'precision')),
        scale: int(tag(xml, 'scale')),
        externalId: tag(xml, 'externalId') === 'true',
        referenceTo: tag(xml, 'referenceTo'),
      });
    }
    // Custom objects have a Name field declared in the object file (`nameField`, Text 80).
    if (object.endsWith('__c')) {
      fields.set('Name', {
        name: 'Name',
        type: 'Text',
        length: 80,
        precision: null,
        scale: null,
        externalId: false,
        referenceTo: null,
      });
    }
    out.set(object, fields);
  }
  return out;
}
