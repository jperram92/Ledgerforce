/**
 * lf/no-session-tenant-context — the tenant context may only be set transaction-locally, inside
 * withTenant (RQ-0013, design §6.7). A session-level app.tenant_id survives COMMIT/ROLLBACK and
 * becomes the context of the next request on that pooled connection. Flags string / template
 * literals containing:
 *  - SET app.tenant_id … / SET SESSION app.tenant_id …   (SET LOCAL is allowed)
 *  - set_config('app.tenant_id', …, false)
 */
import type { Rule } from 'eslint';
import type * as ESTree from 'estree';

const SESSION_SET = /\bset\s+(?:session\s+)?(?!local\b)"?app"?\s*\.\s*"?tenant_id"?\b/i;
const SET_CONFIG_FALSE = /\bset_config\s*\(\s*'app\.tenant_id'\s*,[^)]*,\s*false\s*\)/i;

function check(text: string): boolean {
  return SESSION_SET.test(text) || SET_CONFIG_FALSE.test(text);
}

export const noSessionTenantContext: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow session-level app.tenant_id (leaks across pooled connections)' },
    messages: {
      sessionTenant:
        'Session-level app.tenant_id leaks across pooled connections. Use withTenant(), which sets it transaction-locally (RQ-0013).',
    },
    schema: [],
  },
  create(context) {
    return {
      Literal(node: ESTree.Literal) {
        if (typeof node.value === 'string' && check(node.value)) {
          context.report({ node, messageId: 'sessionTenant' });
        }
      },
      TemplateLiteral(node: ESTree.TemplateLiteral) {
        // Interpolations are opaque: join the static parts with a placeholder.
        const text = node.quasis.map((q) => q.value.cooked ?? q.value.raw).join('$x');
        if (check(text)) context.report({ node, messageId: 'sessionTenant' });
      },
    };
  },
};
