/** A statement could not be imported; the message says why, in words a user can act on. */
export class StatementImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatementImportError';
  }
}

/** The file itself could not be read (format, dates, amounts, balances, mapping). */
export class StatementParseError extends StatementImportError {
  constructor(message: string) {
    super(message);
    this.name = 'StatementParseError';
  }
}
