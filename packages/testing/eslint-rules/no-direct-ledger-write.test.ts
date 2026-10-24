import { noDirectLedgerWrite } from './no-direct-ledger-write.ts';
import { createRuleTester } from './rule-tester.ts';

const tester = createRuleTester();

tester.run('no-direct-ledger-write', noDirectLedgerWrite, {
  valid: [
    // Reads are fine
    "db.query('SELECT * FROM journal_entry WHERE id = $1');",
    'const q = sql`select debit_total from account_balance`;',
    "db.selectFrom('journal_line').selectAll();",
    // Similar-but-different table names
    "db.query('INSERT INTO allocation_rule (id) VALUES ($1)');",
    "db.query('UPDATE journal_entry_template SET name = $1');",
    "db.insertInto('allocation_rule').values(row);",
    // Upsert clause on a non-ledger table
    "db.query('INSERT INTO company (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET name = $2');",
    // Prose that merely mentions the table
    "const help = 'Use the posting engine to write journal_entry rows';",
  ],
  invalid: [
    {
      code: "db.query('INSERT INTO journal_entry (id) VALUES ($1)');",
      errors: [{ messageId: 'directWrite', data: { table: 'journal_entry' } }],
    },
    {
      code: "db.query('insert into app.journal_line (entry_id) values ($1)');",
      errors: [{ messageId: 'directWrite' }],
    },
    {
      code: 'db.query(`UPDATE "account_balance" SET debit_total = ${x}`);',
      errors: [{ messageId: 'directWrite' }],
    },
    {
      code: "db.query('DELETE FROM subledger_entry WHERE id = $1');",
      errors: [{ messageId: 'directWrite' }],
    },
    {
      code: 'const q = sql`delete from ledger.allocation where id = ${id}`;',
      errors: [{ messageId: 'directWrite' }],
    },
    {
      code: "db.query('UPDATE ONLY journal_entry SET status = $1');",
      errors: [{ messageId: 'directWrite' }],
    },
    {
      code: "db.query('TRUNCATE TABLE journal_line');",
      errors: [{ messageId: 'directWrite' }],
    },
    {
      code: 'db.query(`MERGE INTO account_balance b USING x ON true\n WHEN MATCHED THEN UPDATE SET debit_total = 0`);',
      errors: [{ messageId: 'directWrite' }],
    },
    {
      code: "db.query('INSERT INTO dimension_set (id, hash) VALUES ($1, $2)');",
      errors: [{ messageId: 'directWrite', data: { table: 'dimension_set' } }],
    },
    // Kysely query builder
    {
      code: "db.insertInto('journal_entry').values(row).execute();",
      errors: [{ messageId: 'directWrite', data: { table: 'journal_entry' } }],
    },
    {
      code: "db.updateTable('app.account_balance as b').set({ debit_total: x });",
      errors: [{ messageId: 'directWrite' }],
    },
    {
      code: "trx.deleteFrom('allocation').where('id', '=', id);",
      errors: [{ messageId: 'directWrite' }],
    },
    { code: "trx.mergeInto('subledger_entry');", errors: [{ messageId: 'directWrite' }] },
    // custom table list
    {
      code: "db.query('INSERT INTO posting_audit (id) VALUES (1)');",
      options: [{ tables: ['posting_audit'] }],
      errors: [{ messageId: 'directWrite' }],
    },
  ],
});
