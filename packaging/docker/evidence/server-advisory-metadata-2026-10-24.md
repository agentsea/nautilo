# Debian runtime advisory decisions

Four exact Grype High findings have decisions expiring **2026-11-14**.
Scanner severities remain unchanged. These decisions do not establish image
qualification, publication, or deployment.
`observedBy` records scanner provenance; the existing scanner-neutral decisions
match exact advisory, package, installed version, and severity across scanners.

| Package | Installed version | Advisory | Reason |
| --- | --- | --- | --- |
| libexpat1 | 2.9.0-1~deb13u1 | [CVE-2026-113351](https://security-tracker.debian.org/tracker/CVE-2026-113351) | Debian 13 remains vulnerable; no supported fixed package. |
| libexpat1 | 2.9.0-1~deb13u1 | [CVE-2026-115506](https://security-tracker.debian.org/tracker/CVE-2026-115506) | Debian 13 remains vulnerable; no supported fixed package. |
| libharfbuzz0b, libharfbuzz-subset0 | 10.2.0-1+deb13u1 | [CVE-2026-113679](https://security-tracker.debian.org/tracker/CVE-2026-113679) | Debian declares its build unaffected because the wasm backend is disabled. |

Expat's upstream fixes [1431](https://github.com/libexpat/libexpat/pull/1431)
and [1433](https://github.com/libexpat/libexpat/pull/1433) are merged source
changes, not supported Debian binaries. XML parsing dependencies remain in the
image; indirect denial-of-service exposure is not dismissed. HarfBuzz's decision
corrects distribution applicability, rather than accepting a reachable flaw.

On October 24, authenticated Debian `trixie`, `trixie-updates`, and
`trixie-security` binary indexes selected the installed versions above for both
`amd64` and `arm64`. Recheck using `apt-get update` with the Debian archive
keyring and `apt-cache policy` for each package and architecture. Never substitute
an unstable package or upstream source version for a supported binary. The
Dockerfile already upgrades supported packages before installing runtime tools.

The focused fixture retains the relevant fields from both native scanner
reports. Trivy reports Expat as Medium/Unknown and HarfBuzz as Medium; Grype's
four High findings trigger the policy gate. The regression uses synthetic image
bindings and proves exact matching, expiry, and rejection when a scanner reports
a fix for a High/Critical finding. There is no invented fixed-version threshold. Retire the Expat decisions
when a supported fix appears and the HarfBuzz decisions when scanner metadata is
corrected; fresh exact-image qualification remains required for each release.
