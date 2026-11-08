/**
 * A small, tolerant tag reader for OFX 1.x (SGML: leaf elements are not closed), OFX 2.x (XML)
 * and ISO 20022 CAMT.053 (XML), RQ-0019. It builds a plain element tree; it does not validate
 * against a schema and never resolves external entities (there is no DTD processing at all).
 *
 * SGML rule: an element whose name never appears as a closing tag anywhere in the document is a
 * leaf — it ends where the next tag starts. Elements that are closed somewhere (aggregates, or
 * every element in XML) end at their closing tag; a closing tag also ends any unclosed leaves
 * still open inside it.
 */
import { StatementParseError } from './errors.ts';

export interface TagNode {
  name: string;
  attrs: Readonly<Record<string, string>>;
  text: string;
  children: TagNode[];
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

/** Replace the five XML entities, &nbsp; and numeric character references. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]+);/g, (whole, ref: string) => {
    if (ref.startsWith('#x')) return codePoint(ref.slice(2), 16) ?? whole;
    if (ref.startsWith('#')) return codePoint(ref.slice(1), 10) ?? whole;
    return ENTITIES[ref] ?? whole;
  });
}

function codePoint(digits: string, radix: number): string | undefined {
  const cp = parseInt(digits, radix);
  return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : undefined;
}

const localName = (qname: string): string => qname.slice(qname.indexOf(':') + 1);

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of s.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    attrs[m[1] ?? ''] = decodeEntities(m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/** Parse markup into a tree under a synthetic root named "#root". */
export function parseTags(markup: string): TagNode {
  const closed = new Set<string>();
  for (const m of markup.matchAll(/<\/\s*([A-Za-z_][\w.:-]*)\s*>/g)) {
    closed.add(localName(m[1] ?? ''));
  }
  const root: TagNode = { name: '#root', attrs: {}, text: '', children: [] };
  const stack: TagNode[] = [root];
  const top = (): TagNode => stack[stack.length - 1] ?? root;
  const closeOpenLeaf = () => {
    const t = top();
    if (t !== root && !closed.has(t.name)) stack.pop();
  };

  let i = 0;
  while (i < markup.length) {
    const lt = markup.indexOf('<', i);
    const textEnd = lt === -1 ? markup.length : lt;
    if (textEnd > i) top().text += decodeEntities(markup.slice(i, textEnd));
    if (lt === -1) break;

    if (markup.startsWith('<!--', lt)) {
      i = endOf(markup, '-->', lt);
    } else if (markup.startsWith('<![CDATA[', lt)) {
      const end = markup.indexOf(']]>', lt);
      if (end === -1) throw new StatementParseError('unterminated CDATA section');
      top().text += markup.slice(lt + 9, end);
      i = end + 3;
    } else if (markup.startsWith('<?', lt)) {
      i = endOf(markup, '?>', lt);
    } else if (markup.startsWith('<!', lt)) {
      i = endOf(markup, '>', lt); // DOCTYPE and the like: skipped, never processed
    } else {
      const gt = markup.indexOf('>', lt);
      if (gt === -1) throw new StatementParseError('unterminated tag');
      const body = markup.slice(lt + 1, gt).trim();
      i = gt + 1;
      if (body.startsWith('/')) {
        const name = localName(body.slice(1).trim());
        const at = stack.map((n) => n.name).lastIndexOf(name);
        if (at > 0) stack.length = at; // pops the element and any unclosed leaves inside it
        continue;
      }
      const selfClosing = body.endsWith('/');
      const inner = selfClosing ? body.slice(0, -1) : body;
      const m = /^([A-Za-z_][\w.:-]*)([\s\S]*)$/.exec(inner);
      if (!m) throw new StatementParseError(`malformed tag <${body.slice(0, 40)}>`);
      closeOpenLeaf();
      const node: TagNode = {
        name: localName(m[1] ?? ''),
        attrs: parseAttrs(m[2] ?? ''),
        text: '',
        children: [],
      };
      top().children.push(node);
      if (!selfClosing) stack.push(node);
    }
  }
  return root;
}

function endOf(markup: string, terminator: string, from: number): number {
  const end = markup.indexOf(terminator, from);
  if (end === -1) throw new StatementParseError(`unterminated markup starting at ${from}`);
  return end + terminator.length;
}

/** First direct child at a slash-separated path, e.g. child(n, 'Tp/CdOrPrtry/Cd'). */
export function child(node: TagNode | undefined, path: string): TagNode | undefined {
  let cur = node;
  for (const part of path.split('/')) {
    cur = cur?.children.find((c) => c.name === part);
    if (!cur) return undefined;
  }
  return cur;
}

/** All direct children with a name. */
export const childrenNamed = (node: TagNode | undefined, name: string): TagNode[] =>
  node ? node.children.filter((c) => c.name === name) : [];

/** All descendants with a name, in document order. */
export function descendants(node: TagNode, name: string): TagNode[] {
  const out: TagNode[] = [];
  const walk = (n: TagNode) => {
    for (const c of n.children) {
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

/** Trimmed text of the element at the path, or null when absent or blank. */
export function textAt(node: TagNode | undefined, path: string): string | null {
  const t = child(node, path)?.text.trim();
  return t ? t : null;
}
