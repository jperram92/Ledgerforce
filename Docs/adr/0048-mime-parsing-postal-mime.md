---
adr: 0048
title: "Parse inbound bill email with postal-mime"
status: Proposed
date: 2026-11-01
author: claude
category: integration
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0048: Parse inbound bill email with postal-mime

## Status
Proposed — becomes Accepted on green CI plus cross-review by codex (integration category, a new
runtime dependency per design §10.6; no change to the security model).

## Context and problem statement
T-0051 / UC-05: supplier PDFs emailed to the bills inbox become draft bills. RQ-0101 settles on a
transport-agnostic ingest of raw RFC 5322 messages, which needs a MIME parser.

## Considered options
1. postal-mime — MIT-0, no dependencies, standard MIME/RFC 2231 handling.
2. mailparser — MIT, mature, but pulls html-to-text, linkify-it, nodemailer and more.
3. A hand-written parser — MIME edge cases (encodings, nested parts, RFC 2231 names) make this a
   poor use of effort and a security risk.

## Decision outcome
Option 1, `postal-mime@4.0.8` (4.0.6 was first chosen; GHSA-f2hq-32vh-53cc — quadratic CPU on many RFC 2047 encoded words — affects < 4.0.8, found by the dependency gate). Rules: the parser only reads bytes already received (no network);
attachments are size-limited (10 MB) and only PDFs are stored; the sender address is used to
suggest a supplier, never to post anything.

## Consequences
- Small dependency surface; attachments stored in the database (`app.document_attachment`).
- Follow-ups: IMAP polling and provider webhook adapters (T-0127).

## Links
- RQ-0101, T-0051, DL-0289.
