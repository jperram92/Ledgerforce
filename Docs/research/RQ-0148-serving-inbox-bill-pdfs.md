---
id: RQ-0148
title: How should the API serve an emailed bill's PDF to the AP Clerk (content type, Content-Disposition, CSP for an inline viewer, size limits)?
status: resolved
opened: 2026-11-13
resolved: 2026-11-13
opened_by: claude
linked_tasks: [T-0136]
linked_adrs: [ADR-0053, ADR-0054]
superseded_by:
---

# RQ-0148 — Serving inbox bill PDFs

## Question

T-0136 adds `GET /ap/inbox/:id/attachments/:n`, which returns a PDF that arrived by email from
outside the company (T-0051, `app.document_attachment`). The bytes are attacker-controllable: any
sender can mail the bills address.

- Q1. Which `Content-Type` does the response carry, and must the browser be stopped from sniffing?
- Q2. `Content-Disposition: inline` (show it in the page or a new tab) or `attachment` (download),
  and how is the stored file name encoded safely in the header?
- Q3. If the screen showed the PDF inline (an `<iframe>`/`<object>` viewer), what CSP and framing
  headers would that need, and does that fit the API's current headers (ADR-0054, RQ-0141)?
- Q4. What size limits apply to the download?

## Why it matters

Design §6.9 asks for CSP and OWASP ASVS L2; ADR-0054 sends `Content-Security-Policy:
default-src 'none'; frame-ancestors 'none'` and `X-Frame-Options: DENY` on every API response, and
the SPA's nginx CSP has `object-src 'none'; frame-ancestors 'none'`
(`infra/docker/nginx/default.conf.template`). A same-origin document rendered from an emailed file
could run script with the user's session (stored XSS) if the browser treated it as HTML or if a
PDF viewer ran its scripts in the app's origin. Loosening the framing headers to embed it is a
security-model change (a security ADR is a human gate, AGENTS.md §6).

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/File_Upload_Cheat_Sheet.md | 2026-11-13 | primary (OWASP) | "Set a file size limit"; store files outside the webroot; read access only after "Authentication level" and "Authorization level" checks; "The application should set proper request limits as well for the download service if available to protect the server from DoS attacks." Emailed files must get the same treatment as uploads ("Some files are emailed … It is essential to conduct the security measures discussed in this sheet"). |
| S2 | https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/http/reference/headers/content-disposition/index.md | 2026-11-13 | primary (MDN) | `inline` (default) "can be displayed inside the Web page, or as the Web page"; `attachment` "should be downloaded; most browsers presenting a 'Save as' dialog, prefilled with the value of the `filename` parameters". `filename*` uses RFC 5987 encoding and "is preferred over `filename` when both are understood. It's recommended to include both". |
| S3 | https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/http/reference/headers/content-security-policy/sandbox/index.md | 2026-11-13 | primary (MDN) | CSP `sandbox` "enables a sandbox for the requested resource similar to the `<iframe>` sandbox attribute"; without `allow-same-origin` the resource gets an opaque origin and "cannot access `localstorage` and `document.cookie`"; without `allow-scripts` scripts do not run. |
| S4 | https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/HTTP_Headers_Cheat_Sheet.md | 2026-11-13 | primary (OWASP) | `X-Content-Type-Options: nosniff` (stop MIME sniffing); "Use Content Security Policy (CSP) frame-ancestors directive if possible" (obsoletes X-Frame-Options). |
| S5 | RQ-0141 S1 (OWASP REST Security Cheat Sheet §Security Headers) and `apps/api/src/security/security.ts` | 2026-11-13 | primary + source code | Every API response already carries `Cache-Control: no-store`, `CSP default-src 'none'; frame-ancestors 'none'`, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `CORP same-origin`. |
| S6 | `node -e "require('…/express@5.2.1/node_modules/content-disposition')(name)"` (content-disposition 1.1.0, the encoder behind Express `res.attachment`) | 2026-11-13 | experiment | `SUP-INV-991.pdf` → `attachment; filename="SUP-INV-991.pdf"`; `Rechnung "März"\r\n.pdf` → `attachment; filename="Rechnung \"März\"??.pdf"; filename*=UTF-8''Rechnung%20%22M%C3%A4rz%22%0D%0A.pdf`; `../../etc/x.pdf` → `filename="x.pdf"` (basename only). Quotes are escaped, non-ASCII and control characters go only into the percent-encoded `filename*`. |
| S7 | `packages/db/migrations/0045_ap_bill_inbox.sql`, `packages/modules/ap/src/inbox.ts` (repo) | 2026-11-13 | source code | `document_attachment.content_type` is CHECKed to `application/pdf`; `size_bytes BETWEEN 1 AND 10485760` and `octet_length(content) = size_bytes`; ingest refuses a PDF over 10 MB (`MAX_ATTACHMENT`). Rows are RLS-isolated per tenant and immutable. |
| S8 | `infra/docker/nginx/default.conf.template` (repo) | 2026-11-13 | source code | `/ap/...` is proxied to the API on the SPA's origin; the SPA CSP has `object-src 'none'` and `frame-ancestors 'none'`, so an `<object>`/`<embed>` viewer is blocked today and an `<iframe>` of an API URL is refused by the API's own `frame-ancestors 'none'`. |

rfc-editor.org was refused by the session's proxy, so RFC 6266/5987 were read through MDN (S2) and
the encoder was exercised directly (S6).

## Findings

1. **Content type (Q1).** The stored type is always `application/pdf` (S7). Send exactly that and
   keep `X-Content-Type-Options: nosniff` (S4, S5) so a file whose bytes look like HTML is never
   rendered as HTML.
2. **Disposition (Q2).** `attachment` makes the browser save the file rather than render it in the
   app's origin (S2). Inline rendering would run the browser's PDF viewer on attacker-supplied bytes
   at an API URL of the SPA's origin. *Inference:* the CSP `sandbox` directive (S3) would give such a
   document an opaque origin, but `attachment` avoids rendering in our origin at all and needs no
   header relaxation. The file name comes from the sender, so it must be encoded by a tested encoder:
   Express's `res.attachment()` (content-disposition 1.1.0, already shipped with Express 5.2.1, no
   new dependency) escapes quotes, strips the path and puts non-ASCII into `filename*` (S6).
3. **Inline viewer (Q3).** Embedding needs `frame-ancestors 'self'` on the API response and
   `X-Frame-Options` relaxed, plus `object-src`/`frame-src` changes in the SPA CSP (S5, S8). That
   loosens ADR-0054's headers, which is a security-model change and therefore a human gate. Not
   needed for UC-05: the Clerk can open the downloaded file in their own PDF reader beside the form.
4. **Size (Q4).** Stored files are ≤ 10 MB by CHECK and by ingest (S7), which bounds each response.
   Send `Content-Length` (the stored `size_bytes`) so the browser can show progress; the API's
   rate limits (ADR-0054) cover repeated downloads (S1 "request limits … for the download service").
5. **Access (S1).** The route needs authentication and `ap.read`; the row is read in the tenant
   transaction under RLS, so another tenant's item is indistinguishable from a missing one (404).

## Conclusion / decision

- Serve `GET /ap/inbox/:id/attachments/:n` (n = 1-based position, oldest first) under `ap.read`,
  404 when the item or attachment is not visible to the tenant/company.
- Response headers: `Content-Type: application/pdf`, `Content-Disposition: attachment;
  filename=…; filename*=UTF-8''…` via `res.attachment(name)` after replacing control characters
  with `_`, `Content-Length: <size_bytes>`, `Cache-Control: no-store`, `X-Content-Type-Options:
  nosniff`, and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox`
  (defence in depth should a browser ignore the disposition).
- No inline viewer: the screen offers "Download PDF" (a plain link to the route). An inline viewer
  would need a security ADR (human gate) and is not required by UC-05.
- No new runtime dependency. Decision-log entry: DL-0510.

## Confidence

`high` — primary OWASP/MDN sources plus an executed encoder experiment; the size bound is enforced
by the database.

## Follow-ups

- If the product owner wants an inline viewer later, open a security ADR (frame-ancestors and SPA
  CSP change, or a separate sandboxed origin for documents).
- The same route shape will serve a coded bill's PDF (`owner_type = 'supplier_bill'`) when the bill
  page shows attachments.

**Affects:** apps/api `ap` routes (T-0136), apps/web purchases inbox screen, ADR-0054 headers.
