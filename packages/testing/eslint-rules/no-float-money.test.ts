import { noFloatMoney } from './no-float-money.ts';
import { createRuleTester } from './rule-tester.ts';

const tester = createRuleTester();

tester.run('no-float-money', noFloatMoney, {
  valid: [
    // Money/Decimal method calls are the sanctioned way
    'const t = line.amount.add(other.amount);',
    "const g = price.mul('0.1', { scale: 2, rounding: 'half-up' });",
    // String concatenation with a literal is not arithmetic
    "const label = 'Total: ' + total;",
    'const msg = `Tax ${tax}` + taxLabel;',
    // Counters with money-ish prefixes are ignored by the default ignore pattern
    'const n = totalCount + 1;',
    'i = creditIndex - 1;',
    'const pages = totalPages * 2;',
    // Identifiers without money words
    'const x = a + b * c;',
    'counter += 1;',
    // Number.isSafeInteger is not a conversion
    'Number.isSafeInteger(x);',
    // With conversions allowed (outside money packages) only arithmetic is checked
    { code: 'const n = Number(qty);', options: [{ banNumberConversion: false }] },
    { code: 'const s = n.toFixed(2);', options: [{ banNumberConversion: false }] },
    // A custom ignore pattern
    { code: 'const y = taxYear + 1;', options: [{ ignoreIdentifierPattern: 'Year$' }] },
  ],
  invalid: [
    { code: "const a = parseFloat('1.1');", errors: [{ messageId: 'parseFloat' }] },
    { code: "const a = Number.parseFloat('1.1');", errors: [{ messageId: 'parseFloat' }] },
    { code: "const a = globalThis.parseFloat('1.1');", errors: [{ messageId: 'parseFloat' }] },
    { code: "const a = Number('1.1');", errors: [{ messageId: 'numberCoercion' }] },
    { code: "const a = new Number('1.1');", errors: [{ messageId: 'numberCoercion' }] },
    { code: 'const s = amount.toFixed(2);', errors: [{ messageId: 'toFixed' }] },
    { code: 'const s = (a / b).toFixed(2);', errors: [{ messageId: 'toFixed' }] },
    { code: 'const t = amount + fee;', errors: [{ messageId: 'moneyArithmetic' }] },
    { code: 'const t = subtotal * rate;', errors: [{ messageId: 'moneyArithmetic' }] },
    { code: 'const t = line.debit - line.credit;', errors: [{ messageId: 'moneyArithmetic' }] },
    { code: 'const t = invoice.totalAmount / 3;', errors: [{ messageId: 'moneyArithmetic' }] },
    { code: 'const t = unitPrice % 2;', errors: [{ messageId: 'moneyArithmetic' }] },
    { code: 'const t = TAX_RATE ** 2;', errors: [{ messageId: 'moneyArithmetic' }] },
    { code: 'total += line;', errors: [{ messageId: 'moneyArithmetic' }] },
    { code: 'doc.credit -= 1;', errors: [{ messageId: 'moneyArithmetic' }] },
    { code: 'amount++;', errors: [{ messageId: 'moneyArithmetic' }] },
    { code: 'const n = -amount;', errors: [{ messageId: 'moneyArithmetic' }] },
    { code: 'const n = +price;', errors: [{ messageId: 'moneyArithmetic' }] },
    {
      code: 'const t = Number(amount) * 2;',
      errors: [{ messageId: 'numberCoercion' }],
    },
    {
      // arithmetic still checked when conversions are allowed
      code: 'const t = amount * 2;',
      options: [{ banNumberConversion: false }],
      errors: [{ messageId: 'moneyArithmetic' }],
    },
    {
      code: 'const t = totalCount + 1;',
      options: [{ ignoreIdentifierPattern: '^$' }],
      errors: [{ messageId: 'moneyArithmetic' }],
    },
  ],
});
