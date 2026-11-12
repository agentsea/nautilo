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
