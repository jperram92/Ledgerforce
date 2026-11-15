---
id: RQ-0150
title: Should customer invoices print the company's own bank account, and with which controls?
status: resolved
opened: 2026-11-15
resolved: 2026-11-15
opened_by: claude
linked_tasks: [T-0165, T-0180]
linked_adrs: [ADR-0079]
superseded_by:
---

# RQ-0150: Remittance bank details on customer invoices

## Question
ADR-0079 proposes printing the company's designated remittance account (account name, BSB, account number) on invoices. That means decrypting it for customer documents, which ADR-0018 today allows only for payment files. Is this best practice, and what controls should come with it?

## Findings
- **F1 — Common practice, not an ATO requirement.** Australian bank guidance for small business lists the BSB and account number (or PayID), with the invoice number as the payment reference, among the payment options an invoice should show. The ATO tax-invoice fields do not require bank details (Westpac; Sprintlaw; Wise AU).
- **F2 — Payment-redirection fraud is the main risk.** Business email compromise alters the bank details on otherwise genuine invoices. The guidance is consistent:
  - payers should verify changed details by phone, using a number they already hold;
  - businesses should restrict who can change payment details, require approval (dual authorisation) for changes, and audit them;
  - PayID or name-matching checks are preferred where available.

  Sources: ACSC/cyber.gov.au BEC guidance; ANZ, NAB and Westpac scam pages; MinterEllison on loss allocation. A NSW decision also shows that a payer may still owe the debt after funds are diverted.
- **F3 — Decrypt only where needed (OWASP Cryptographic Storage and Key Management cheat sheets).** Limit decryption to the code path that needs the clear value, keep the key boundary, and do not persist the clear value elsewhere.

## Conclusion
Accept ADR-0079 with these controls:
1. **One designated account.** Only the designated remittance account (`ar_settings.remittance_bank_account_id`) is ever decrypted for documents. Customer and supplier accounts never print.
2. **Controlled changes.** Setting or changing it is a controlled change:
   - permission `settings.setup.manage`;
   - step-up;
   - a second-person approval, under the same maker-checker as supplier bank-detail changes (design §6.5);
   - audited, with old and new values masked to the last 3 digits.
3. **Print scope.** Invoices print the account name, BSB and full account number with the invoice number as the reference. They also carry a fixed line telling customers to confirm any change of bank details by phone before paying (F2).
4. **No copies of the clear value.** Decryption happens only in the document render path. The clear value is never stored in the outbox or the logs.

## Sources
- [Westpac — how to write an invoice](https://westpac.com.au/business-banking/business-help/cash-flow/how-to-write-an-invoice)
- [Sprintlaw — ATO tax invoice requirements](https://www.sprintlaw.com.au/articles/ato-tax-invoice-requirements-what-must-be-on-your-invoices)
- [Wise AU — how to make a tax invoice](https://wise.com/au/blog/how-to-make-tax-invoice)
- [cyber.gov.au — business email compromise](https://cyber.gov.au/node/1667)
- [ANZ — payment redirection scams](https://www.anz.com.au/security/types-of-scams/payment-redirection-scam/)
- [NAB — avoid email scams](https://www.nab.com.au/about-us/security/online-safety-tips-business/avoid-email-scams)
- [Westpac — business email scams](https://www.westpac.com.au/security/types-of-scams/business-email-scams/)
- [MinterEllison — invoice diversion fraud: who bears the loss](https://www.minterellison.com/articles/invoice-diversion-fraud-who-bears-the-loss)
- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
- [OWASP Key Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html)
