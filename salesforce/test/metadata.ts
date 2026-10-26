/**
 * Loads the LedgerForce SFDX project from disk for the offline contract test (DL-0094).
 * Layout per the source-deploy-retrieve registry (RQ-0022 S6). Every `*-meta.xml` is read with
 * the strict reader; a file whose kind is unknown fails the load, so stray metadata cannot hide.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseXml, type XmlElement } from './xml.ts';

export const SALESFORCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface MetadataFile {
  /** Path relative to the salesforce/ root, with forward slashes. */
  path: string;
  root: XmlElement;
  /** Root element the file's kind requires (CustomObject, CustomField, …). */
  expectedRoot: string;
  /** Component name derived from the file name (e.g. LF_Id__c, LF_Read_Only). */
  componentName: string;
}

export interface FieldMeta {
  path: string;
  root: XmlElement;
}

export interface ObjectMeta {
  /** `<Obj>.object-meta.xml`; undefined for standard objects that only receive fields/rules. */
  meta: XmlElement | undefined;
  fields: Map<string, FieldMeta>;
  validationRules: Map<string, FieldMeta>;
}

export interface LoadedPackage {
  files: MetadataFile[];
  /** Every file under salesforce/ except dependencies and the tests themselves. */
  allFiles: { path: string; content: string }[];
  objects: Map<string, ObjectMeta>;
  permissionSets: Map<string, XmlElement>;
  customPermissions: Set<string>;
  /** Lightning web component bundles by name (`lwc/<name>/<name>.js-meta.xml`, T-0072). */
  lwcBundles: Map<string, XmlElement>;
}

/** Suffix → expected root element, for every metadata kind the package may contain. */
const KINDS: [suffix: string, root: string][] = [
  ['.object-meta.xml', 'CustomObject'],
  ['.field-meta.xml', 'CustomField'],
  ['.validationRule-meta.xml', 'ValidationRule'],
  ['.permissionset-meta.xml', 'PermissionSet'],
  ['.customPermission-meta.xml', 'CustomPermission'],
  ['.cls-meta.xml', 'ApexClass'],
  ['.js-meta.xml', 'LightningComponentBundle'],
];

const SKIP_DIRS = new Set(['node_modules', '.sf', '.sfdx', 'test']);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...(await walk(join(dir, entry.name))));
    } else {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

export async function loadPackage(root: string): Promise<LoadedPackage> {
  const pkg: LoadedPackage = {
    files: [],
    allFiles: [],
    objects: new Map(),
    permissionSets: new Map(),
    customPermissions: new Set(),
    lwcBundles: new Map(),
  };
  const objectOf = (name: string): ObjectMeta => {
    let o = pkg.objects.get(name);
    if (!o) {
      o = { meta: undefined, fields: new Map(), validationRules: new Map() };
      pkg.objects.set(name, o);
    }
    return o;
  };

  for (const abs of (await walk(root)).sort()) {
    const path = relative(root, abs).split(sep).join('/');
    const content = await readFile(abs, 'utf8');
    pkg.allFiles.push({ path, content });
    if (!path.startsWith('force-app/') || !path.endsWith('-meta.xml')) continue;

    const kind = KINDS.find(([suffix]) => path.endsWith(suffix));
    if (!kind) throw new Error(`unknown metadata kind: ${path}`);
    const [suffix, expectedRoot] = kind;
    const fileName = path.slice(path.lastIndexOf('/') + 1);
    const componentName = fileName.slice(0, -suffix.length);
    let xml: XmlElement;
    try {
      xml = parseXml(content);
    } catch (error) {
      throw new Error(`${path}: ${(error as Error).message}`, { cause: error });
    }
    pkg.files.push({ path, root: xml, expectedRoot, componentName });

    const parts = path.split('/');
    // force-app/main/default/<kindDir>/...
    const kindDir = parts[3];
    if (kindDir === 'objects') {
      const objectName = parts[4] ?? '';
      const object = objectOf(objectName);
      if (expectedRoot === 'CustomObject') {
        if (componentName !== objectName) throw new Error(`object file misplaced: ${path}`);
        object.meta = xml;
      } else if (expectedRoot === 'CustomField' && parts[5] === 'fields') {
        object.fields.set(componentName, { path, root: xml });
      } else if (expectedRoot === 'ValidationRule' && parts[5] === 'validationRules') {
        object.validationRules.set(componentName, { path, root: xml });
      } else {
        throw new Error(`unexpected file under objects/: ${path}`);
      }
    } else if (kindDir === 'permissionsets' && expectedRoot === 'PermissionSet') {
      pkg.permissionSets.set(componentName, xml);
    } else if (kindDir === 'customPermissions' && expectedRoot === 'CustomPermission') {
      pkg.customPermissions.add(componentName);
    } else if (kindDir === 'classes' && expectedRoot === 'ApexClass') {
      // Apex classes: checked through allFiles and the apiVersion rule.
    } else if (kindDir === 'lwc' && expectedRoot === 'LightningComponentBundle') {
      // force-app/main/default/lwc/<bundle>/<bundle>.js-meta.xml
      if (parts.length !== 6 || parts[4] !== componentName) {
        throw new Error(`LWC metadata misplaced: ${path}`);
      }
      pkg.lwcBundles.set(componentName, xml);
    } else {
      throw new Error(`file in the wrong folder for its kind: ${path}`);
    }
  }
  return pkg;
}

/** First direct child with this name. */
export function one(el: XmlElement, name: string): XmlElement | undefined {
  return el.children.find((c) => c.name === name);
}

/** All descendants with this name (depth-first). */
export function all(el: XmlElement, name: string): XmlElement[] {
  return el.children.flatMap((c) => [...(c.name === name ? [c] : []), ...all(c, name)]);
}

/** Text of the first direct child with this name, or undefined when absent. */
export function text(el: XmlElement, name: string): string | undefined {
  return one(el, name)?.text;
}
