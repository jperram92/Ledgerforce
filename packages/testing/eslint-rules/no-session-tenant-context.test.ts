import { noSessionTenantContext } from './no-session-tenant-context.ts';
import { createRuleTester } from './rule-tester.ts';

const tester = createRuleTester();

// RQ-0013: a session-level app.tenant_id outlives its transaction on a pooled connection.
tester.run('no-session-tenant-context', noSessionTenantContext, {
  valid: [
    // transaction-local, the only allowed form
    "const q = sql`SELECT set_config('app.tenant_id', ${id}, true)`;",
    'db.query("SELECT set_config(\'app.tenant_id\', $1, true)", [id]);',
    "db.query('SET LOCAL app.tenant_id = $1');",
    // reading it is fine
    'db.query("SELECT current_setting(\'app.tenant_id\', true)");',
    // resetting it is fine
    "db.query('RESET app.tenant_id');",
    // other settings are not this rule's business
    "db.query('SET search_path = app');",
  ],
  invalid: [
    { code: "db.query('SET app.tenant_id = $1');", errors: [{ messageId: 'sessionTenant' }] },
    {
      code: "db.query('set session app.tenant_id to $1');",
      errors: [{ messageId: 'sessionTenant' }],
    },
    {
      code: "const q = sql`SELECT set_config('app.tenant_id', ${id}, false)`;",
      errors: [{ messageId: 'sessionTenant' }],
    },
    {
      code: 'db.query("select set_config( \'app.tenant_id\' , $1 , FALSE )");',
      errors: [{ messageId: 'sessionTenant' }],
    },
  ],
});
