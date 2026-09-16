# @nautilo/attachments

Secure attachment ingestion for Nautilo.

This package owns attachment envelopes, centralized policy constants,
classification/security decisions, and content adapters. Transport adapters may
convert source-specific input into `AttachmentEnvelope` values, but they must not
decide whether a file is safe.

Required flow:

```text
transport adapter -> AttachmentEnvelope -> AttachmentSecurityGate -> content adapter
```

The gate is authoritative for MIME/magic-byte arbitration, size caps,
executable/archive rejection, and path validation hooks. Content adapters consume
accepted or stubbed classifications only.
