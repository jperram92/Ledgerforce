// Minimal YAML reader for the subset used by .agent/config.yaml and task-card frontmatter
// (DL-0005: zero npm dependencies). Supported:
//   - block maps (`key: value`, `key:` + indented block)
//   - block lists (`- item`, `- key: v` list-of-maps, `-` + indented block), incl. lists at
//     the same indent as their parent key
//   - flow lists/maps (`[a, b]`, `{ a: 1, b: [x] }`), nested
//   - scalars: plain, "double" (JSON-style escapes), 'single' ('' escape), ints, floats,
//     true/false, null/~/empty; timestamps stay strings
//   - comments (`# …` at line start or after whitespace, never inside quotes)
//   - literal block scalars (`key: |`)
// Not supported (throws or treats as plain text): anchors/aliases, tags, multi-document
// streams, folded `>` scalars, complex keys. Errors carry 1-based line numbers.

export class YamlError extends Error {}

interface Line { indent: number; text: string; no: number }

function fail(no: number, msg: string): never {
  throw new YamlError(`YAML line ${no}: ${msg}`);
}

/** Remove a trailing comment that is outside quotes and preceded by whitespace (or at col 0). */
export function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (q === '"' && c === '\\') { i++; continue; }
      if (c === q) {
        if (q === "'" && s[i + 1] === "'") { i++; continue; }
        q = null;
      }
      continue;
    }
    if ((c === '"' || c === "'") && (i === 0 || /[\s:\[\]{},-]/.test(s[i - 1]))) { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function toLines(text: string): { lines: Line[]; raw: string[] } {
  const raw = text.replace(/\r\n?/g, '\n').split('\n');
  const lines: Line[] = [];
  raw.forEach((r, idx) => {
    const lead = r.match(/^[ \t]*/)![0];
    if (lead.includes('\t') && r.trim() !== '') fail(idx + 1, 'tab characters are not allowed in indentation');
    const t = stripComment(r);
    if (t.trim() === '') return;
    lines.push({ indent: lead.length, text: t.slice(lead.length), no: idx + 1 });
  });
  return { lines, raw };
}

export function parseYaml(text: string): unknown {
  const { lines, raw } = toLines(text);
  if (lines.length === 0) return null;
  const p = new BlockParser(lines, raw);
  const v = p.parseBlock(lines[0].indent);
  if (p.i < lines.length) fail(lines[p.i].no, `unexpected indentation or content: "${lines[p.i].text}"`);
  return v;
}

/** Split `key: rest` at the first `: ` / trailing `:` that is outside quotes and brackets. */
function splitKey(text: string): { key: string; rest: string } | null {
  let q: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"') i++; continue; }
    if (c === '"' || c === "'") { if (i === 0) q = c; continue; }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ':' && depth === 0 && (i === text.length - 1 || text[i + 1] === ' ')) {
      let key = text.slice(0, i).trim();
      if (/^".*"$/.test(key)) key = JSON.parse(key);
      else if (/^'.*'$/.test(key)) key = key.slice(1, -1).replace(/''/g, "'");
      return { key, rest: text.slice(i + 1).trim() };
    }
  }
  return null;
}

class BlockParser {
  lines: Line[];
  raw: string[];
  i = 0;
  constructor(lines: Line[], raw: string[]) { this.lines = lines; this.raw = raw; }

  parseBlock(indent: number): unknown {
    const first = this.lines[this.i];
    if (first.text === '-' || first.text.startsWith('- ')) return this.parseList(indent);
    return this.parseMap(indent);
  }

  parseMap(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    while (this.i < this.lines.length) {
      const ln = this.lines[this.i];
      if (ln.indent < indent) break;
      if (ln.indent > indent) fail(ln.no, `unexpected indentation: "${ln.text}"`);
      if (ln.text === '-' || ln.text.startsWith('- ')) break; // list at same indent ends the map
      const kv = splitKey(ln.text);
      if (!kv) fail(ln.no, `expected "key: value", got "${ln.text}"`);
      if (Object.prototype.hasOwnProperty.call(out, kv.key)) fail(ln.no, `duplicate key "${kv.key}"`);
      this.i++;
      out[kv.key] = this.parseValueAfterKey(kv.rest, indent, ln);
    }
    return out;
  }

  parseValueAfterKey(rest: string, indent: number, ln: Line): unknown {
    if (rest === '|' || rest === '|-') return this.parseLiteral(indent, ln, rest === '|-');
    if (rest !== '') return parseInline(rest, ln.no);
    const next = this.lines[this.i];
    if (!next) return null;
    if (next.indent > indent) return this.parseBlock(next.indent);
    if (next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) return this.parseList(indent);
    return null;
  }

  parseLiteral(indent: number, ln: Line, chomp: boolean): string {
    // Literal blocks need the raw text (comments are content), so read raw lines.
    const body: string[] = [];
    let r = ln.no; // raw index of the next line (ln.no is 1-based)
    let blockIndent = -1;
    while (r < this.raw.length) {
      const s = this.raw[r];
      if (s.trim() === '') { body.push(''); r++; continue; }
      const ind = s.match(/^ */)![0].length;
      if (ind <= indent) break;
      if (blockIndent < 0) blockIndent = ind;
      if (ind < blockIndent) break;
      body.push(s.slice(blockIndent));
      r++;
    }
    while (body.length && body[body.length - 1] === '') body.pop();
    while (this.i < this.lines.length && this.lines[this.i].no <= r) this.i++;
    const txt = body.join('\n');
    return chomp ? txt : txt + '\n';
  }

  parseList(indent: number): unknown[] {
    const out: unknown[] = [];
    while (this.i < this.lines.length) {
      const ln = this.lines[this.i];
      if (ln.indent < indent) break;
      if (ln.indent > indent) fail(ln.no, `unexpected indentation: "${ln.text}"`);
      if (!(ln.text === '-' || ln.text.startsWith('- '))) break;
      this.i++;
      const rest = ln.text === '-' ? '' : ln.text.slice(2).trim();
      if (rest === '') {
        const next = this.lines[this.i];
        out.push(next && next.indent > indent ? this.parseBlock(next.indent) : null);
        continue;
      }
      const kv = rest.startsWith('[') || rest.startsWith('{') || rest.startsWith('"') || rest.startsWith("'") ? null : splitKey(rest);
      if (kv) {
        // `- key: v` starts a map whose further keys sit at the column of `key`.
        const col = ln.indent + (ln.text.length - ln.text.slice(1).trimStart().length);
        const map: Record<string, unknown> = {};
        map[kv.key] = this.parseValueAfterKey(kv.rest, col, { ...ln, indent: col });
        const next = this.lines[this.i];
        if (next && next.indent === col && !(next.text === '-' || next.text.startsWith('- '))) {
          Object.assign(map, this.parseMap(col));
        } else if (next && next.indent > indent && next.indent !== col && !(next.indent > col)) {
          fail(next.no, `bad indentation inside list item: "${next.text}"`);
        }
        out.push(map);
      } else {
        out.push(parseInline(rest, ln.no));
      }
    }
    return out;
  }
}

// ---------- inline (flow + scalar) ----------

function parseInline(text: string, no: number): unknown {
  const s = text.trim();
  if (s.startsWith('[') || s.startsWith('{')) {
    const fp = new FlowParser(s, no);
    const v = fp.value();
    fp.ws();
    if (fp.pos !== s.length) fail(no, `unexpected text after flow collection: "${s.slice(fp.pos)}"`);
    return v;
  }
  return parseScalar(s, no);
}

export function parseScalar(s: string, no = 0): unknown {
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) fail(no, `unterminated double-quoted string: ${s}`);
    try { return JSON.parse(s); } catch { fail(no, `bad double-quoted string: ${s}`); }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) fail(no, `unterminated single-quoted string: ${s}`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number.parseFloat(s);
  return s;
}

class FlowParser {
  s: string; pos = 0; no: number;
  constructor(s: string, no: number) { this.s = s; this.no = no; }
  ws(): void { while (this.pos < this.s.length && /\s/.test(this.s[this.pos])) this.pos++; }
  value(): unknown {
    this.ws();
    const c = this.s[this.pos];
    if (c === '[') return this.list();
    if (c === '{') return this.map();
    return this.scalar(false);
  }
  list(): unknown[] {
    this.pos++;
    const out: unknown[] = [];
    this.ws();
    if (this.s[this.pos] === ']') { this.pos++; return out; }
    for (;;) {
      out.push(this.value());
      this.ws();
      const c = this.s[this.pos];
      if (c === ',') { this.pos++; this.ws(); if (this.s[this.pos] === ']') { this.pos++; return out; } continue; }
      if (c === ']') { this.pos++; return out; }
      fail(this.no, `expected "," or "]" in flow list`);
    }
  }
  map(): Record<string, unknown> {
    this.pos++;
    const out: Record<string, unknown> = {};
    this.ws();
    if (this.s[this.pos] === '}') { this.pos++; return out; }
    for (;;) {
      this.ws();
      const key = String(this.scalar(true));
      this.ws();
      if (this.s[this.pos] !== ':') fail(this.no, `expected ":" after key "${key}" in flow map`);
      this.pos++;
      this.ws();
      const c = this.s[this.pos];
      out[key] = c === ',' || c === '}' ? null : this.value();
      this.ws();
      const d = this.s[this.pos];
      if (d === ',') { this.pos++; this.ws(); if (this.s[this.pos] === '}') { this.pos++; return out; } continue; }
      if (d === '}') { this.pos++; return out; }
      fail(this.no, `expected "," or "}" in flow map`);
    }
  }
  scalar(isKey: boolean): unknown {
    const c = this.s[this.pos];
    if (c === '"' || c === "'") {
      let j = this.pos + 1;
      while (j < this.s.length) {
        if (c === '"' && this.s[j] === '\\') { j += 2; continue; }
        if (this.s[j] === c) {
          if (c === "'" && this.s[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      if (j >= this.s.length) fail(this.no, 'unterminated quoted string in flow collection');
      const tok = this.s.slice(this.pos, j + 1);
      this.pos = j + 1;
      return parseScalar(tok, this.no);
    }
    const start = this.pos;
    while (this.pos < this.s.length) {
      const ch = this.s[this.pos];
      if (ch === ',' || ch === ']' || ch === '}' || ch === '[' || ch === '{') break;
      if (ch === ':' && (isKey ? true : /[\s,\]}]/.test(this.s[this.pos + 1] ?? ' '))) break;
      this.pos++;
    }
    if (this.pos >= this.s.length) fail(this.no, 'unterminated flow collection');
    const tok = this.s.slice(start, this.pos).trim();
    return isKey ? tok : parseScalar(tok, this.no);
  }
}

// ---------- writer (scalars and flow lists only — enough for frontmatter updates) ----------

/** Format a value so that `key: <formatScalar(v)>` parses back to exactly v. */
export function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new YamlError(`cannot format non-finite number ${v}`);
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(formatFlowItem).join(', ')}]`;
  if (typeof v === 'string') {
    const plainOk = v !== '' && /^[A-Za-z0-9_./@+\-][A-Za-z0-9_ ./@+:\-]*$/.test(v) && !/: /.test(v) && !v.endsWith(':')
      && !v.endsWith(' ') && typeof parseScalar(v) === 'string' && !v.startsWith('- ');
    return plainOk ? v : JSON.stringify(v);
  }
  throw new YamlError(`cannot format value of type ${typeof v}`);
}

function formatFlowItem(v: unknown): string {
  if (typeof v === 'string') {
    const ok = v !== '' && /^[A-Za-z0-9_./@+\-][A-Za-z0-9_./@+\-]*$/.test(v) && typeof parseScalar(v) === 'string';
    return ok ? v : JSON.stringify(v);
  }
  if (Array.isArray(v) || (v !== null && typeof v === 'object')) throw new YamlError('nested collections are not supported by formatScalar');
  return formatScalar(v);
}
