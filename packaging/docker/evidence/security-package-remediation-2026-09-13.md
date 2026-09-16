# Debian security updates — 13 September 2026

The review covers every current server and bootstrap vulnerability exception:
132 distinct CVEs, 260 server decisions, three bootstrap decisions, and 30
Debian binary packages. Both amd64 and arm64 stable package indexes were
checked against the Debian security tracker. The complete package/advisory
review and index hashes are retained in
[`debian-security-review-2026-09-13.json`](../fixtures/debian-security-review-2026-09-13.json).

## Updates available now

| Shipped package | Previous version | Required supported version |
| --- | --- | --- |
| libc6, libc-bin | 2.41-12+deb13u3 | 2.41-12+deb13u4 |
| libglib2.0-0t64 | 2.84.4-3~deb13u3 | 2.84.4-3~deb13u5 |
| gzip | 1.13-1 | 1.13-1+deb13u1 |
| libpcre2-8-0 | 10.46-1~deb13u1 | 10.46-1~deb13u2 |
| perl-base | 5.40.1-6 | 5.40.1-6+deb13u1 |
| libsqlite3-0 | 3.46.1-7+deb13u1 | 3.46.1-7+deb13u2 |

These stable updates address 25 distinct CVEs. Remove 28 server exception
entries and two bootstrap entries. The duplicate count reflects different
binary packages and scanner severity identities for the same advisory.

The server already runs `apt-get upgrade` during its uncached runtime stage.
The new package floor check makes the reviewed fixes mandatory and invalidates
older cached local builds; newer supported Debian updates remain allowed.
There is no Bun version change and no move to Debian unstable.

The pinned distroless bootstrap base and its current `nonroot` tag still
contain glibc `2.41-12+deb13u3`. While upstream's rebuilt image is unavailable,
the build obtains the official `libc6=2.41-12+deb13u4` package through signed
Debian apt indexes and overlays its extracted runtime files. Its original
control record and checksum inventory replace the old distroless package
metadata. This keeps the no-OpenSSL, nonroot runtime and lets scanners inspect
the actual installed version. Remove the overlay when a reviewed upstream
base contains the same fix or newer; update the base evidence and rerun both
native architecture audits at that time.

## Exceptions that remain

The remaining 232 server decisions cover 107 CVEs. Chromium's supported
Debian 13 version is still `152.0.7977.82-1~deb13u1` on both architectures;
its 88 advisory exceptions cannot yet be removed by a supported package
upgrade. Upstream/development fixes are recorded as removal thresholds,
not presented as available Debian 13 packages.

`CVE-2026-5435` remains open in glibc after this update; retain its two server
package decisions and one bootstrap decision at the exact new version.
`CVE-2026-9538` remains open in Perl; retain its exact updated package decision.
Those changed decisions were reviewed again and expire on 1 October. Other
unchanged decisions keep their original dates and expiry. No exception can
waive an available fix, a changed version/severity, or expiry.

Historical scanner replays use a frozen September 11 policy fixture. Current
policy tests independently require complete review coverage, removal of every
supported fixed decision, exact updated package identities, and bounded expiry.
This avoids making old scan receipts depend on today's package inventory.

## Verification and release boundary

Both native architectures passed the complete image audits and runtime probes
at source `71c593e11d74471dc188ede0015abb9adbc65053`:

- [Server qualification 34755801951](https://github.com/agentsea/nautilo/actions/runs/34755801951):
  310 normalized high/critical findings and 232 used decisions per architecture;
  zero failures and zero unused decisions.
- [Bootstrap qualification 34755800077](https://github.com/agentsea/nautilo/actions/runs/34755800077):
  one remaining Grype finding and one used decision per architecture;
  zero failures and zero unused decisions.

The complete finding sets, source/image/Dockerfile identities, scanner database
identities, and raw-report hashes are retained in
[`native-security-remediation-2026-09-13.json`](../fixtures/native-security-remediation-2026-09-13.json).
The follow-up commit adds only this record, that fixture, and its replay tests;
it changes no image implementation or dependency input. All 106 packaging
tests pass, including full-inventory replay and failure on unreviewed findings,
available fixes, and expired decisions. Both pairs of retained raw reports
also replay against the final policy without failures or warnings.

These branch qualifications do not prove stable-channel publication or deployed
adoption. A merge starts the canonical main build. The older main run
34649137609 was still awaiting `cli-release` approval during this review and
holding newer main runs pending; do not approve that superseded, unpatched
candidate as a substitute for the corrected release. No instance is deployed
by this change.

Primary sources:

- [Debian security tracker data](https://security-tracker.debian.org/tracker/data/json)
- [Debian glibc CVE-2026-5450](https://security-tracker.debian.org/tracker/CVE-2026-5450)
- [Debian glibc CVE-2026-5928](https://security-tracker.debian.org/tracker/CVE-2026-5928)
- [Remaining glibc CVE-2026-5435](https://security-tracker.debian.org/tracker/CVE-2026-5435)
- [Remaining Perl CVE-2026-9538](https://security-tracker.debian.org/tracker/CVE-2026-9538)
- [Distroless upstream](https://github.com/GoogleContainerTools/distroless)
