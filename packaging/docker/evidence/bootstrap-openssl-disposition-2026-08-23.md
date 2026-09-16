# Hosted-bootstrap system OpenSSL disposition — 2026-08-23

## Scope

This disposition covers the hosted-bootstrap image finding for
`CVE-2026-14456` on `libssl3t64 3.5.6-1~deb13u2`. It does not renew or broaden
the server-image exception inventory.

## Retained baseline

The AMD64 and ARM64 evidence artifacts from hosted-bootstrap workflow run
[`32648868316`](https://github.com/agentsea/nautilo/actions/runs/32648868316)
were replayed with the production evaluator. Both architectures failed only on
the same two exact tuples:

- `grype / CVE-2026-14456 / libssl3t64 / 3.5.6-1~deb13u2 / high`
- `trivy / CVE-2026-14456 / libssl3t64 / 3.5.6-1~deb13u2 / high`

The Debian tracker describes this as unbounded pending-channel allocation in
an OpenSSL QUIC server listener and marks trixie as vulnerable with no DSA and
the fix postponed:
<https://security-tracker.debian.org/tracker/CVE-2026-14456>.

## Necessity and reachability

The final image previously inherited system OpenSSL from
`gcr.io/distroless/base-debian13`. The compiled Bun bootstrap executable does
not dynamically link `libssl`; its ELF dependencies are limited to glibc,
`libpthread`, `libdl`, and `libm`. Its only inbound listener is the plain HTTP
request-memory handoff in `hosted-logto-bootstrap.ts`; it does not create a TLS
or QUIC listener. Outbound PostgreSQL and HTTPS clients remain owned by the
compiled Bun executable.

The Distroless project provides `base-nossl-debian13` for applications that
need glibc but do not need system libssl:
<https://github.com/GoogleContainerTools/distroless/blob/main/base/README.md>.

## Decision

Remove the unnecessary system OpenSSL package by using the supported,
digest-pinned `base-nossl-debian13:nonroot` runtime. Do not add exceptions for
the two OpenSSL scanner tuples.

The exact resulting Debian closure is seven packages: `base-files`,
`ca-certificates`, `libc6`, `media-types`, `netbase`, `tzdata`, and
`tzdata-legacy`. The release gate rejects any drift from that closure.

Local ARM64 qualification proved:

- the compiled image starts as `nonroot:nonroot` on a read-only filesystem;
- missing-environment, invalid-mode, and missing-database behavior is
  unchanged;
- the executable has no dynamic system-OpenSSL dependency;
- an outbound HTTPS request completed TLS and received the expected remote
  HTTP response;
- pinned Syft reported the seven-package closure above;
- pinned Grype reported only the three already reviewed, non-fixable libc
  findings and pinned Trivy reported no high/critical findings; and
- the existing three exact libc exceptions were all consumed with zero
  unmatched, fixable, expired, or unused exceptions.

Native AMD64 and ARM64 workflow receipts remain the publication authority for
the final candidate.
