/**
 * A strict reader for the XML subset used by Salesforce source-format metadata (DL-0094).
 *
 * Accepted: an optional `<?xml …?>` declaration at the very start, elements (also self-closing),
 * double-quoted attributes, text, comments, the five predefined entities and numeric character
 * references. Refused (XmlError with a line number): DOCTYPE, CDATA, other processing
 * instructions, mixed content (text next to child elements), unknown entities, a bare `&` or
 * `<`, more than one root, anything outside the root but whitespace and comments.
 */

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  /** Decoded text content; '' for elements that only contain children or nothing. */
  text: string;
}

export class XmlError extends Error {
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = 'XmlError';
  }
}

const NAME = /[A-Za-z_][\w.:-]*/y;
const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function parseXml(source: string): XmlElement {
  let pos = 0;
  const line = () => source.slice(0, pos).split('\n').length;
  const fail = (message: string): never => {
    throw new XmlError(message, line());
  };

  const skipWhitespaceAndComments = () => {
    for (;;) {
      while (pos < source.length && /\s/.test(source.charAt(pos))) pos++;
      if (!source.startsWith('<!--', pos)) return;
      const end = source.indexOf('-->', pos + 4);
      if (end < 0) fail('unterminated comment');
      pos = end + 3;
    }
  };

  const startsName = (at: number): boolean => {
    NAME.lastIndex = at;
    return NAME.test(source);
  };

  const readName = (): string => {
    NAME.lastIndex = pos;
    const m = NAME.exec(source);
    if (!m) return fail('expected a name');
    pos += m[0].length;
    return m[0];
  };

  const decode = (raw: string): string =>
    raw.replace(/&([^;\s&<]*);|&|</g, (match, entity: string | undefined) => {
      if (match === '<') return fail('bare "<" in text');
      if (entity === undefined) return fail('bare "&" in text');
      const numeric = /^#(?:x([0-9a-fA-F]+)|([0-9]+))$/.exec(entity);
      if (numeric)
        return String.fromCodePoint(parseInt(numeric[1] ?? numeric[2] ?? '', numeric[1] ? 16 : 10));
      const named = ENTITIES[entity];
      if (named === undefined) return fail(`unknown entity &${entity};`);
      return named;
    });

  const readElement = (): XmlElement => {
    if (source.charAt(pos) !== '<') fail('expected "<"');
    pos++;
    const name = readName();
    const attributes: Record<string, string> = {};
    for (;;) {
      const before = pos;
      while (/\s/.test(source.charAt(pos))) pos++;
      if (source.startsWith('/>', pos)) {
        pos += 2;
        return { name, attributes, children: [], text: '' };
      }
      if (source.charAt(pos) === '>') {
        pos++;
        break;
      }
      if (pos === before) fail('expected whitespace before an attribute');
      const attr = readName();
      if (source.charAt(pos) !== '=' || source.charAt(pos + 1) !== '"') {
        fail(`attribute ${attr} must be written ${attr}="…"`);
      }
      pos += 2;
      const end = source.indexOf('"', pos);
      if (end < 0) fail('unterminated attribute value');
      if (Object.hasOwn(attributes, attr)) fail(`duplicate attribute ${attr}`);
      attributes[attr] = decode(source.slice(pos, end));
      pos = end + 1;
    }

    const children: XmlElement[] = [];
    let rawText = '';
    for (;;) {
      if (pos >= source.length) fail(`element <${name}> is not closed`);
      if (source.startsWith('</', pos)) {
        pos += 2;
        const closing = readName();
        if (closing !== name) fail(`expected </${name}> but found </${closing}>`);
        while (/\s/.test(source.charAt(pos))) pos++;
        if (source.charAt(pos) !== '>') fail('expected ">"');
        pos++;
        break;
      }
      if (source.startsWith('<!--', pos)) {
        const end = source.indexOf('-->', pos + 4);
        if (end < 0) fail('unterminated comment');
        pos = end + 3;
        continue;
      }
      if (source.startsWith('<![CDATA[', pos)) fail('CDATA sections are not supported');
      if (source.startsWith('<?', pos)) fail('processing instructions are not supported');
      if (source.startsWith('<!', pos)) fail('declarations are not supported');
      if (source.charAt(pos) === '<') {
        if (!startsName(pos + 1)) fail('bare "<" in text');
        children.push(readElement());
        continue;
      }
      // Text up to the next "<".
      let end = source.indexOf('<', pos);
      if (end < 0) end = source.length;
      rawText += source.slice(pos, end);
      pos = end;
    }

    const text = decode(rawText);
    if (children.length > 0 && text.trim() !== '') fail(`mixed content in <${name}>`);
    return { name, attributes, children, text: children.length > 0 ? '' : text };
  };

  if (source.startsWith('﻿')) fail('byte-order mark is not allowed');
  if (source.startsWith('<?xml')) {
    const end = source.indexOf('?>');
    if (end < 0) fail('unterminated XML declaration');
    pos = end + 2;
  }
  skipWhitespaceAndComments();
  if (pos >= source.length) fail('empty document');
  if (source.startsWith('<!', pos)) fail('declarations are not supported');
  if (source.startsWith('<?', pos)) fail('processing instructions are not supported');
  const root = readElement();
  skipWhitespaceAndComments();
  if (pos < source.length) fail('content after the root element');
  return root;
}
