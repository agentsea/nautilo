# Native server and bootstrap audit review — November 8, 2026

Both native server inventories contain the same 554 High/Critical scanner
findings. The raw scanners report no fixed versions for these tuples. This is
not a vulnerability-free image: the newly reviewed findings below are residual
vulnerabilities in the latest supported Debian 13 packages.

The server policy retires 96 unused decisions: 94 Chromium tuples for the old
`156.0.8078.73-1~deb13u1` packages and two `CVE-2026-85091` tuples for
`libminizip1t64` and `zlib1g`. The build now requires at least
`156.0.8078.79-1~deb13u1` for both Chromium packages on both architectures,
invalidating cached older package layers.

## Current supported packages and removal conditions

| Package family | Installed supported version | Primary evidence and removal condition |
| --- | --- | --- |
| Chromium | `156.0.8078.79-1~deb13u1` | [Debian tracker](https://security-tracker.debian.org/tracker/source-package/chromium) and [binary package availability](https://packages.debian.org/trixie/chromium-headless-shell): the 127 newly observed advisories remain open in Trixie. Upstream fixes start at `157.0.8103.38`; remove each exact decision when a supported fixed build or equivalent backport is available. |
| Expat | `2.9.0-1~deb13u1` | [CVE-2026-117610](https://security-tracker.debian.org/tracker/CVE-2026-117610) and [CVE-2026-118370](https://security-tracker.debian.org/tracker/CVE-2026-118370): `2.9.0` remains vulnerable; `2.10.0-1` is fixed in unstable/testing, without a supported Trixie backport. |
| SQLite | `3.46.1-7+deb13u2` | [Debian tracker](https://security-tracker.debian.org/tracker/source-package/sqlite3): CVE-2026-119373, CVE-2026-119374 and CVE-2026-119379 remain open/no-DSA in Trixie. The Debian source fix starts at `3.54.1-1`, upstream `3.54.0`; remove on a supported fixed backport. |
| glibc | `2.41-12+deb13u4` | [CVE-2026-84243](https://security-tracker.debian.org/tracker/CVE-2026-84243): Trixie remains open/no-DSA and no fixed Debian version is published. Remove at the first supported fix. |
| libXi | `2:1.8.2-1` | [CVE-2026-109089](https://security-tracker.debian.org/tracker/CVE-2026-109089) and [CVE-2026-109090](https://security-tracker.debian.org/tracker/CVE-2026-109090): Trixie remains vulnerable/no-DSA; `2:1.8.4-1` is available only in unstable/testing. Each native candidate's fresh apt-secure probe confirms the supported candidate remains `2:1.8.2-1`. A changed candidate or available fixed backport rejects the exception. |

The 410 newly unmatched scanner findings yield 307 exact server risk tuples.
There are 46 Chromium package/advisory/version groups where the scanners assign
different High/Critical severities; both observed severity tuples remain explicit.
Four architecture-specific libXi decisions are renewed after fresh review. The
bootstrap adds only the Grype High `CVE-2026-84243` tuple for `libc6`; its two
existing decisions remain unchanged.

All new and renewed decisions expire November 15, 2026. There is no automatic
renewal. A different advisory, package, installed version, or unreviewed severity
remains blocking. A newly reported installable fix remains blocking. Web package
metadata is supporting evidence; only the libXi availability assertions are
bound to the retained native apt-secure probes.

The complete minimal fixtures preserve raw fix states, fixed versions and
severities. Image, database and signed-index bindings in unit tests are synthetic;
local replay also evaluates the retained native reports with their original
bindings. All four native replays have zero failures and zero unused applicable
exceptions. These replays do not replace a fresh successful release qualification.
