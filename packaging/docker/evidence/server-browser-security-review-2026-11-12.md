# Server browser security refresh — November 12, 2026

The Debian 13 browser available for both native architectures remains
`156.0.8078.79-1~deb13u1`. The image instead uses Google's official Stable
Chrome for Testing headless shell `157.0.8103.78`, selected from the
[official platform manifest](https://googlechromelabs.github.io/chrome-for-testing/).
Both archive and original executable hashes are pinned in
[`chromium-artifacts.json`](../chromium-artifacts.json). The complete resource
and license tree is retained; its identity, shared-library closure and three
OfficeCLI rendering formats are required by native release qualification.

The vendor's [November 9 security release](https://chromereleases.googleblog.com/2026/11/stable-channel-update-for-desktop_018223192.html)
fixes CVE-2026-125343, CVE-2026-125344, CVE-2026-125345,
CVE-2026-125347, CVE-2026-125348 and CVE-2026-125350 in
`157.0.8103.50`; the selected stable build is newer. The vendor reports
exploitation of CVE-2026-125350. Its older browser must not receive a new
release exception merely because Debian has not packaged the fix.
The [November 3 release](https://chromereleases.googleblog.com/2026/11/stable-channel-update-for-desktop.html)
fixes CVE-2026-121040 and CVE-2026-121220 in `157.0.8103.38`.

Removing a Debian package does not by itself establish browser vulnerability
coverage. The audit retains raw Syft output, adds an explicit source-pinned
Google Chrome CPE after verifying the actual image's executable and receipt,
and supplies the augmented inventory to Grype. Trivy still scans image OS
packages, configuration, secrets and licenses; the browser component's explicit
upstream CPE coverage is provided by Grype. The release gate rejects missing
or changed provenance and browser identity. A real scanner control detected
CVE-2026-125350 for `156.0.8078.79` and excluded it for `157.0.8103.78`.

The patched-browser scan retains a Medium CVE-2015-1239 match with an unbounded
Chrome version constraint. [NVD](https://nvd.nist.gov/vuln/detail/CVE-2015-1239)
describes an old OpenJPEG issue. The exact browser source tag's PDFium
revision identifies OpenJPEG 2.5.4; that is source-version evidence, not an
attestation of the binary's embedded subcomponent. The scanner finding is not
suppressed and no exception is added for it.

## Kerberos packages still awaiting supported Debian fixes

MIT [1.22.3](https://web.mit.edu/kerberos/krb5-1.22/) and its
[security advisory](https://web.mit.edu/kerberos/advisories/MITKRB5-SA-2026-001.txt)
fix CVE-2026-112314, CVE-2026-107364, CVE-2026-118380,
CVE-2026-71199 and CVE-2026-71200. Debian's corresponding security tracker
entries still mark Trixie `1.21.3-5+deb13u1` unfixed. Supported main, updates
and security package indexes were checked for amd64 and arm64; no patched
binary was available at review time. Upstream release availability is not an
installable Debian update, and a Debian backport version must not be invented.

The policy retains twenty exact new scanner/package/version/severity decisions
for the four installed Kerberos libraries. They expire on December 12, 2026,
and must be retired sooner when a supported Debian binary contains a
vendor-confirmed backport or the upstream 1.22.3 fix. Indirect reachability is
not dismissed. This review does not replace fresh per-architecture image,
scanner, runtime and publication qualification.


## Bounded review of retained Debian packages

The November 12 supported-package review renews only 53 expiring server
risk decisions and the one bootstrap `CVE-2026-84243` decision. Their review
timestamp is `2026-11-12T13:19:21Z`; the bounded expiry is
`2026-12-12T00:00:00Z`. The server inventory remains 149 decisions. Scanner,
advisory, package, installed version, severity, owner and architecture-specific
`unavailableFix` identities remain unchanged. The preceding browser-replacement
policy is frozen separately so its dated replay retains the original decisions.

| Family and renewed decisions | Installed version | Primary fix evidence and removal condition |
| --- | --- | --- |
| Kerberos: 40 server decisions, CVE-2026-112315 through CVE-2026-112323 and CVE-2026-119079 across four libraries | `1.21.3-5+deb13u1` | [MIT 1.22.3 release notes](https://web.mit.edu/kerberos/krb5-1.22/) explicitly identify every advisory as fixed; [MIT advisory](https://web.mit.edu/kerberos/advisories/MITKRB5-SA-2026-001.txt) describes the risks. [Debian krb5 tracker](https://security-tracker.debian.org/tracker/source-package/krb5) still marks Trixie unfixed. Remove when a supported binary contains the 1.22.3 fix or a vendor-confirmed backport. No Debian backport version is invented. |
| Expat: four server decisions, CVE-2026-113351, CVE-2026-115506, CVE-2026-117610, CVE-2026-118370 | `2.9.0-1~deb13u1` | [Debian Expat tracker](https://security-tracker.debian.org/tracker/source-package/expat) and [upstream 2.10.0 changes](https://github.com/libexpat/libexpat/blob/R_2_10_0/expat/Changes). Fixed Debian `2.10.0-1` exists only in unstable/testing. Remove on a supported 2.10.0 fix or confirmed backport. |
| SQLite: three server decisions, CVE-2026-119373, CVE-2026-119374, CVE-2026-119379 | `3.46.1-7+deb13u2` | [Debian SQLite tracker](https://security-tracker.debian.org/tracker/source-package/sqlite3) and [upstream 3.54.0 release](https://www.sqlite.org/releaselog/3_54_0.html). Debian fixed threshold `3.54.1-1` is available in unstable (Sid); testing (Forky) `3.53.4-2` remains vulnerable, without a supported Trixie update. Remove on a supported 3.54.0 fix or confirmed backport. |
| glibc: two server decisions and one bootstrap decision, CVE-2026-84243 | `2.41-12+deb13u4` | [Debian tracker](https://security-tracker.debian.org/tracker/CVE-2026-84243) and [upstream fix](https://sourceware.org/git/?p=glibc.git;a=commit;h=03067f3c5e39aec5ec250a44bc1b395a1afd45e8), present in development 2.45. No fixed Debian package is published. Remove on a supported binary containing that commit or a vendor-confirmed equivalent backport. |
| libXi: four architecture-specific server decisions, CVE-2026-109089 and CVE-2026-109090 | `2:1.8.2-1` | [CVE-2026-109089](https://security-tracker.debian.org/tracker/CVE-2026-109089) and [CVE-2026-109090](https://security-tracker.debian.org/tracker/CVE-2026-109090): upstream fixed `1.8.4`, Debian fixed `2:1.8.4-1` only in unstable/testing. Preserve the exact native apt-secure availability proof; a changed candidate, installed version or supported fixed backport blocks the decision. |

The supported Trixie main, updates and security indexes for both amd64 and
arm64 contain no installable patched package for these exact decisions. The
[amd64 security index](https://security.debian.org/debian-security/dists/trixie-security/main/binary-amd64/Packages.xz)
and [arm64 security index](https://security.debian.org/debian-security/dists/trixie-security/main/binary-arm64/Packages.xz)
are authoritative package inputs alongside the corresponding main and updates
indexes. Availability in unstable/testing or an upstream source release does
not establish an installable supported target fix.

These are bounded residual-risk decisions, not vulnerability removal or fresh
installed-image acceptance. Indirect native-library reachability is not
dismissed. A supported patch must be installed and rescanned immediately when
available; the exceptions must not cover it. The unchanged 14-day warning
window begins November 28 for the renewed decisions, and expiry remains
blocking on December 12. There is no automatic renewal. Existing unrelated
December 7 decisions retain their earlier warning and expiry boundaries.

## Exclude the unused CUPS dependency

The pinned headless browser does not require the CUPS shared library. The
explicit dependency list had carried `libcups2t64` over from a broader browser
installation profile; it is removed from the runtime apt request. The build
also rejects an installed `libcups2t64`, so a transitive reintroduction cannot
silently restore the affected library. No CUPS vulnerability exception is
added. Browser executable and bundled-library linkage checks remain mandatory.

The intended image contains no affected CUPS library. Fresh native amd64 and
arm64 images must still prove package absence, complete linkage, all three
OfficeCLI rendering formats, and successful vulnerability audits before
publication. Source dependency removal alone is not installed-image evidence.
