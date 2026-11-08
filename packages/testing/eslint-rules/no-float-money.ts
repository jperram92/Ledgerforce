/**
 * lf/no-float-money — floating-point arithmetic on money is banned (design §3.4, AGENTS.md §4).
 *
 * Without type information a lint rule cannot know which values are money, so this rule uses two
 * syntactic heuristics:
 *  1. Number conversions (`parseFloat`, `Number(...)`, `new Number`, `.toFixed(...)`) — banned
 *     outright in money-handling packages (ledger, modules, shared/money). Toggle with
 *     `banNumberConversion` for other code.
 *  2. Arithmetic operators (+ - * / % **, compound assignment, ++/--, unary +/-) applied to an
 *     identifier or property whose name matches `moneyIdentifierPattern`
 *     (default /amount|debit|credit|total|price|tax/i). Names matching `ignoreIdentifierPattern`
 *     (default: counters such as totalCount, creditIndex, totalPages) are skipped, and `+` with a
 *     string/template operand is treated as concatenation.
 * Money must be handled with `Money` (packages/shared/money) methods instead.
 */
import type { Rule } from 'eslint';
import type * as ESTree from 'estree';

const DEFAULT_MONEY = 'amount|debit|credit|total|price|tax';
const DEFAULT_IGNORE =
  '(count|counts|index|idx|length|len|size|pages|page|rows|lines|items|attempts|ms|seconds|year|years)$';
const ARITHMETIC = new Set(['+', '-', '*', '/', '%', '**']);
const ASSIGN_ARITHMETIC = new Set(['+=', '-=', '*=', '/=', '%=', '**=']);

interface Options {
  banNumberConversion?: boolean;
  moneyIdentifierPattern?: string;
  ignoreIdentifierPattern?: string;
}

function nameOf(node: ESTree.Node): string | undefined {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    return node.property.name;
  }
  if (
    node.type === 'MemberExpression' &&
    node.property.type === 'Literal' &&
    typeof node.property.value === 'string'
  ) {
    return node.property.value;
  }
  return undefined;
}

function isStringy(node: ESTree.Node): boolean {
  return (
    (node.type === 'Literal' && typeof node.value === 'string') || node.type === 'TemplateLiteral'
  );
}

export const noFloatMoney: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow floating-point conversions and arithmetic on money values',
    },
    messages: {
      parseFloat: 'parseFloat produces a float; parse money with Money.of / Money.fromNumeric.',
      numberCoercion:
        'Number(...) converts to a float; keep money as Money/Decimal (decimal strings at the edges).',
      toFixed: 'toFixed() is float formatting; use Money#toNumericString() or Money#roundTo(...).',
      moneyArithmetic:
        "Arithmetic operator on money-like value '{{name}}'; use Money methods (add/sub/mul/allocate).",
    },
    schema: [
      {
        type: 'object',
        properties: {
          banNumberConversion: { type: 'boolean' },
          moneyIdentifierPattern: { type: 'string' },
          ignoreIdentifierPattern: { type: 'string' },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const opts = (context.options[0] ?? {}) as Options;
    const banConversion = opts.banNumberConversion ?? true;
    const moneyRe = new RegExp(opts.moneyIdentifierPattern ?? DEFAULT_MONEY, 'i');
    const ignoreRe = new RegExp(opts.ignoreIdentifierPattern ?? DEFAULT_IGNORE, 'i');

    const moneyName = (node: ESTree.Node): string | undefined => {
      const n = nameOf(node);
      return n !== undefined && moneyRe.test(n) && !ignoreRe.test(n) ? n : undefined;
    };

    const report = (node: ESTree.Node, name: string): void => {
      context.report({ node, messageId: 'moneyArithmetic', data: { name } });
    };

    const isGlobalCall = (callee: ESTree.Node, fn: string): boolean => {
      if (callee.type === 'Identifier') return callee.name === fn;
      return (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier' &&
        callee.property.name === fn &&
        callee.object.type === 'Identifier' &&
        (callee.object.name === 'globalThis' ||
          callee.object.name === 'window' ||
          (fn === 'parseFloat' && callee.object.name === 'Number'))
      );
    };

    const conversionChecks = (node: ESTree.CallExpression | ESTree.NewExpression): void => {
      if (!banConversion) return;
      const callee = node.callee;
      if (node.type === 'CallExpression' && isGlobalCall(callee, 'parseFloat')) {
        context.report({ node, messageId: 'parseFloat' });
        return;
      }
      if (isGlobalCall(callee, 'Number')) {
        context.report({ node, messageId: 'numberCoercion' });
        return;
      }
      if (
        node.type === 'CallExpression' &&
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'toFixed'
      ) {
        context.report({ node, messageId: 'toFixed' });
      }
    };

    return {
      CallExpression: conversionChecks,
      NewExpression: conversionChecks,
      BinaryExpression(node) {
        if (!ARITHMETIC.has(node.operator)) return;
        if (node.operator === '+' && (isStringy(node.left) || isStringy(node.right))) return;
        const name =
          (node.left.type !== 'PrivateIdentifier' ? moneyName(node.left) : undefined) ??
          moneyName(node.right);
        if (name !== undefined) report(node, name);
      },
      AssignmentExpression(node) {
        if (!ASSIGN_ARITHMETIC.has(node.operator)) return;
        if (node.operator === '+=' && isStringy(node.right)) return;
        const name = moneyName(node.left) ?? moneyName(node.right);
        if (name !== undefined) report(node, name);
      },
      UpdateExpression(node) {
        const name = moneyName(node.argument);
        if (name !== undefined) report(node, name);
      },
      UnaryExpression(node) {
        if (node.operator !== '-' && node.operator !== '+') return;
        const name = moneyName(node.argument);
        if (name !== undefined) report(node, name);
      },
    };
  },
};
