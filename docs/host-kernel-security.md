# Host kernel security

Nautilo containers share the Docker daemon's Linux kernel. Updating a Debian,
Bun, Logto, or database container does not install an Ubuntu host kernel update.
Docker Desktop runs its own Linux VM; updating macOS or a container alone does
not update that VM.

## Ubuntu TCP security update

[CVE-2026-98432](https://ubuntu.com/security/CVE-2026-98432) affects Linux IPv4
TCP connection handling. Apply your host vendor's fixed kernel and reboot into
it. Installing the package without rebooting does not establish protection.

The standard Nautilo image startup checks the running Ubuntu build through
`/proc/version_signature` before starting the server. The administrator CLI
also probes the selected Docker daemon before a Compose deployment or upgrade,
before owner setup, maintenance drain, backup, or service replacement. A detected
affected Ubuntu build is refused with host-update guidance. Probe failures are
refusals; they are not successful security checks.

The check retains Ubuntu's complete build version, flavour, and backport suffix.
It does not compare generic and cloud kernels interchangeably. Recognized
streams cover generic, AWS, Azure, GCP, Oracle, KVM, and lowlatency builds for
which the published policy has vendor evidence. An unsupported vendor, flavour,
branch, custom kernel, or unavailable Ubuntu signature is reported as
**unverified**, never as patched. Consult the host vendor or managed provider.

Before retrying a refused deployment:

1. Preserve a current recovery copy and arrange a maintenance window for every
   service on the host, including authentication and databases.
2. Refresh the supported Ubuntu security/update repositories and upgrade the
   installed kernel tracking package, such as `linux-virtual`, `linux-generic`,
   or the appropriate cloud kernel package. Do not install a different flavour
   merely because its version number appears newer.
3. Reboot the host through its normal maintenance procedure.
4. Inspect `uname -r`, `/proc/version_signature`, and the matching installed
   `linux-image` package. Compare the exact release and package stream with
   Ubuntu's advisory, then retry Nautilo's operation.

This release supplies admission checks and operator guidance, not a replacement
kernel, livepatch attestation, or an automatic host reboot. The normal startup
check does not protect independent host services or command overrides that do
not run Nautilo's entrypoint. Recovery and restart operations do not gain the
CLI deployment preflight; their startup check depends on the image they launch.
Third-party hosting providers remain responsible
for their managed kernels. Docker Desktop users must install a vendor release
containing the fix, rather than infer its status from `uname` alone.

The Ubuntu security-test VM recipe upgrades its tracking kernel, restarts the
new guest, and requires a recognized fixed running build before creating its
baseline. That baseline's kernel still requires normal security maintenance.
