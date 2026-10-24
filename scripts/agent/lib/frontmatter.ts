// Task-card frontmatter: parse, and update individual top-level keys in place so that
// comments, ordering and the markdown body are preserved byte-for-byte.
import { parseYaml, formatScalar, stripComment } from './yaml.ts';

export interface Frontmatter {
  data: Record<string, any>;
  /** raw frontmatter text between the fences (no fences) */
  raw: string;
  /** everything after the closing fence line */
  body: string;
}

const OPEN = /^---[ \t]*\r?\n/;

function locate(text: string): { start: number; end: number; bodyStart: number } {
  const m = text.match(OPEN);
  if (!m) throw new Error('missing frontmatter: file must start with a "---" line');
  const start = m[0].length;
  const close = /^---[ \t]*$/m;
  const rest = text.slice(start);
  const c = rest.match(close);
  if (!c || c.index === undefined) throw new Error('unterminated frontmatter: no closing "---" line');
  const end = start + c.index;
  let bodyStart = end + c[0].length;
  if (text[bodyStart] === '\r') bodyStart++;
  if (text[bodyStart] === '\n') bodyStart++;
  return { start, end, bodyStart };
}

export function parseFrontmatter(text: string): Frontmatter {
  const { start, end, bodyStart } = locate(text);
  const raw = text.slice(start, end);
  const data = parseYaml(raw);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('frontmatter must be a YAML map');
  }
  return { data: data as Record<string, any>, raw, body: text.slice(bodyStart) };
}

/**
 * Set top-level keys. Existing `key: value   # comment` lines keep their comment and column;
 * keys that are missing are appended at the end of the frontmatter.
 * Only scalar / flat-list values are supported (that is all the conductor writes).
 */
export function updateFrontmatter(text: string, updates: Record<string, unknown>): string {
  const { start, end } = locate(text);
  const lines = text.slice(start, end).split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const [key, value] of Object.entries(updates)) {
    const formatted = formatScalar(value);
    const idx = lines.findIndex((l) => l.startsWith(`${key}:`) && (l.length === key.length + 1 || /\s/.test(l[key.length + 1])));
    if (idx < 0) {
      lines.push(`${key}: ${formatted}`);
      continue;
    }
    const line = lines[idx];
    const valuePart = stripComment(line);
    const comment = line.slice(valuePart.length); // whitespace + "# ..." or ''
    let newLine = `${key}: ${formatted}`;
    if (comment.trim().startsWith('#')) {
      const hashCol = line.indexOf('#', valuePart.length);
      const pad = Math.max(1, hashCol - newLine.length);
      newLine += ' '.repeat(pad) + comment.trim();
    }
    // a nested block under this key (indented lines) would be orphaned; drop-in replace is only for scalars
    lines[idx] = newLine;
  }
  return text.slice(0, start) + lines.join('\n') + '\n' + text.slice(end);
}
