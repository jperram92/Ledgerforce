/**
 * lf/no-direct-ledger-write — only the posting engine (packages/ledger) may write the ledger
 * tables (design §3.9, AGENTS.md §4/§5). Flags, outside packages/ledger:
 *  - string / template literals containing INSERT INTO | UPDATE | DELETE FROM | MERGE INTO |
 *    TRUNCATE | COPY targeting a ledger table (optionally schema-qualified / quoted / ONLY);
 *  - Kysely builders insertInto / updateTable / deleteFrom / mergeInto / replaceInto with a
 *    ledger table name.
 * Reads (SELECT) are allowed. Template literal interpolations are treated as opaque.
 */
import type { Rule } from 'eslint';
import type * as ESTree from 'estree';

export const DEFAULT_LEDGER_TABLES = [
  'journal_entry',
  'journal_line',
  'account_balance',
  'subledger_entry',
  'allocation',
] as const;

const KYSELY_WRITE_METHODS = new Set([
  'insertInto',
  'updateTable',
  'deleteFrom',
  'mergeInto',
  'replaceInto',
]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildLedgerWriteRegex(tables: readonly string[]): RegExp {
  const ident = '"?[A-Za-z_][A-Za-z0-9_]*"?';
  const tableAlt = tables.map(escapeRe).join('|');
  return new RegExp(
    String.raw`\b(?:insert\s+into|update|delete\s+from|merge\s+into|truncate(?:\s+table)?|copy)\s+` +
      String.raw`(?:only\s+)?(?:${ident}\s*\.\s*)?"?(${tableAlt})"?(?![A-Za-z0-9_])`,
    'i',
  );
}

function kyselyTarget(arg: ESTree.Node | undefined, tables: ReadonlySet<string>): string | undefined {
  if (arg?.type !== 'Literal' || typeof arg.value !== 'string') return undefined;
  // 'schema.table as alias' -> table
  const first = arg.value.trim().split(/\s+/)[0] ?? '';
  const table = first.split('.').pop()?.replace(/"/g, '') ?? '';
  return tables.has(table) ? table : undefined;
}

export const noDirectLedgerWrite: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow writing ledger tables outside the posting engine (packages/ledger)',
    },
    messages: {
      directWrite:
        "Direct write to ledger table '{{table}}'. Only the posting engine (packages/ledger) may write ledger tables.",
    },
    schema: [
      {
        type: 'object',
        properties: { tables: { type: 'array', items: { type: 'string' }, minItems: 1 } },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const opts = (context.options[0] ?? {}) as { tables?: string[] };
    const tables = opts.tables ?? [...DEFAULT_LEDGER_TABLES];
    const re = buildLedgerWriteRegex(tables);
    const tableSet = new Set(tables);

    const checkText = (node: ESTree.Node, text: string): void => {
      const m = re.exec(text);
      if (m) {
        context.report({ node, messageId: 'directWrite', data: { table: m[1] ?? '' } });
      }
    };

    return {
      Literal(node) {
        if (typeof node.value === 'string') checkText(node, node.value);
      },
      TemplateLiteral(node) {
        checkText(node, node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(' $x '));
      },
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          KYSELY_WRITE_METHODS.has(callee.property.name)
        ) {
          const table = kyselyTarget(node.arguments[0] as ESTree.Node | undefined, tableSet);
          if (table !== undefined) {
            context.report({ node, messageId: 'directWrite', data: { table } });
          }
        }
      },
    };
  },
};
