#!/usr/bin/env python3
"""Generate and verify the credential-free runner trust bootstrap.

GitHub downloads repository actions before job steps begin. This policy supplies
maintained trust to file-based clients after step execution starts. Native OS
clients, Docker daemons, the provider control channel, and action archive
acquisition have separate trust boundaries.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys


INLINE_PROGRAM = r'''import gzip, hashlib, io, json, os, re, ssl, subprocess, sys, tarfile, urllib.parse, urllib.request
from pathlib import Path
APK_URL = "https://dl-cdn.alpinelinux.org/alpine/v3.23/main/x86_64/ca-certificates-bundle-20261020-r0.apk"
APK_SHA256 = "a4c5de1bf37652cd98cbe71aec209512ae0508a964961957a6c9650f795e46c4"
BUNDLE_SHA256 = "5961c0a3c65459931c023e0075c09733f09aea4ca439cb85bc4a08bb4f3f568b"
# Host policy: G3B, G3C, and the AAA cross-sign. Bun retains its separate six-root guard.
BLOCKED = {"7dd78d5f4f13459a83dff9abbba62edbaf6f2d102bf257fd712f4d9f2746ed8d",
           "86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b",
           "d7a7a0fb5d7e2731d771e9484ebcdef71d5f0c3e0a2948782bc83ee0ea699ef4"}
PEM = re.compile(rb"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", re.S)
EXPORTS = ("SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "PIP_CERT",
           "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH", "CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE", "AWS_CA_BUNDLE", "npm_config_cafile")
def restrict_windows_roots():
    if os.name != "nt" or os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted" or os.environ.get("RUNNER_OS") != "Windows":
        raise RuntimeError("Native root repair is limited to an ephemeral GitHub-hosted Windows runner")
    script = r"""$ErrorActionPreference = 'Stop'
$blocked = @('7dd78d5f4f13459a83dff9abbba62edbaf6f2d102bf257fd712f4d9f2746ed8d', '86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b', 'd7a7a0fb5d7e2731d771e9484ebcdef71d5f0c3e0a2948782bc83ee0ea699ef4')
function Fingerprint($certificate) { $certificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant() }
$found = @{}
foreach ($location in @('LocalMachine', 'CurrentUser')) {
  foreach ($name in @('Root', 'CA')) {
    $store = [System.Security.Cryptography.X509Certificates.X509Store]::new($name, $location)
    try {
      $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly -bor [System.Security.Cryptography.X509Certificates.OpenFlags]::OpenExistingOnly)
      foreach ($certificate in @($store.Certificates)) {
        $fingerprint = Fingerprint $certificate
        if ($blocked -contains $fingerprint) { $found[$fingerprint] = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certificate.RawData) }
      }
    } finally { $store.Close(); $store.Dispose() }
  }
}
# Establish native distrust before removing the copies CPython imports into OpenSSL.
foreach ($location in @('LocalMachine', 'CurrentUser')) {
  $store = [System.Security.Cryptography.X509Certificates.X509Store]::new('Disallowed', $location)
  try {
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite -bor [System.Security.Cryptography.X509Certificates.OpenFlags]::OpenExistingOnly)
    foreach ($certificate in $found.Values) { $store.Add($certificate) }
  } finally { $store.Close(); $store.Dispose() }
  $store = [System.Security.Cryptography.X509Certificates.X509Store]::new('Disallowed', $location)
  try {
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly -bor [System.Security.Cryptography.X509Certificates.OpenFlags]::OpenExistingOnly)
    $present = @($store.Certificates | ForEach-Object { Fingerprint $_ })
    foreach ($fingerprint in $found.Keys) { if ($present -notcontains $fingerprint) { throw 'Native distrust was not installed' } }
  } finally { $store.Close(); $store.Dispose() }
}
foreach ($location in @('LocalMachine', 'CurrentUser')) {
  foreach ($name in @('Root', 'CA')) {
    $store = [System.Security.Cryptography.X509Certificates.X509Store]::new($name, $location)
    try {
      $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite -bor [System.Security.Cryptography.X509Certificates.OpenFlags]::OpenExistingOnly)
      foreach ($certificate in @($store.Certificates)) {
        if ($blocked -contains (Fingerprint $certificate)) { $store.Remove($certificate) }
      }
    } finally { $store.Close(); $store.Dispose() }
  }
}
Write-Host ('Restricted exact incident root identities on the ephemeral Windows runner: ' + $found.Count)
"""
    subprocess.run(["pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], check=True, timeout=60)
    # CPython also sees policy, enterprise, service and other-user collections.
    # Never alter those stores; refuse the runner if any affected copy remains.
    verify = "import hashlib,json,ssl,sys; denied=set(json.loads(sys.argv[1])); present={hashlib.sha256(cert).hexdigest() for name in ('CA','ROOT') for cert,encoding,trust in ssl.enum_certificates(name) if encoding=='x509_asn'}; assert not (denied & present), 'An affected Windows root remains visible to Python'"
    subprocess.run([sys.executable, "-c", verify, json.dumps(sorted(BLOCKED))], check=True, timeout=30)
def download():
    request = urllib.request.Request(APK_URL, headers={"User-Agent": "nautilo-runner-trust-bootstrap/1"})
    with urllib.request.urlopen(request, timeout=30) as response:
        if urllib.parse.urlparse(response.geturl()).scheme != "https": raise RuntimeError("Runner trust package redirected outside HTTPS")
        payload = response.read(2_000_001)
    if len(payload) > 2_000_000: raise RuntimeError("Runner trust package exceeds the bootstrap limit")
    return payload
def qualify_bundle(bundle):
    if not bundle.strip(): raise RuntimeError("Maintained CA bundle is empty or malformed")
    try:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.load_verify_locations(cadata=bundle.decode("ascii"))
    except (UnicodeDecodeError, ValueError, ssl.SSLError) as error:
        raise RuntimeError("Maintained CA bundle contains malformed certificates") from error
    certificates = PEM.findall(bundle)
    if not certificates or PEM.sub(b"", bundle).strip(): raise RuntimeError("Maintained CA bundle is empty or malformed")
    fingerprints = {hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert.decode())).hexdigest() for cert in certificates}
    exposed = sorted(BLOCKED & fingerprints)
    if exposed: raise RuntimeError("Maintained CA bundle contains blocked roots: " + ", ".join(exposed))
    return len(certificates)
def prepare(payload, runner_temp, github_env):
    if hashlib.sha256(payload).hexdigest() != APK_SHA256: raise RuntimeError("Runner trust package hash mismatch before extraction")
    try:
        archive = gzip.decompress(payload)
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:", ignore_zeros=True) as package:
            selected = [item for item in package.getmembers() if item.name == "etc/ssl/certs/ca-certificates.crt"]
            if len(selected) != 1 or not selected[0].isfile(): raise RuntimeError("Runner trust package lacks the exact regular CA bundle")
            stream = package.extractfile(selected[0])
            if stream is None: raise RuntimeError("Runner trust package CA bundle is unreadable")
            bundle = stream.read(1_000_001)
    except (gzip.BadGzipFile, EOFError, tarfile.TarError) as error:
        raise RuntimeError("Runner trust package is not a valid APK archive") from error
    if len(bundle) > 1_000_000 or hashlib.sha256(bundle).hexdigest() != BUNDLE_SHA256: raise RuntimeError("Maintained CA bundle hash mismatch")
    root_count = qualify_bundle(bundle); temp = Path(runner_temp)
    if not temp.is_dir() or temp.is_symlink(): raise RuntimeError("Runner temporary path is not a real directory")
    root = temp / "nautilo-runner-trust"
    if root.exists() or root.is_symlink(): raise RuntimeError("Runner trust destination already exists")
    root.mkdir(mode=0o700); ca, empty = root / "ca-certificates.crt", root / "empty-ca-directory"
    with ca.open("xb") as output: output.write(bundle)
    ca.chmod(0o600); empty.mkdir(mode=0o700)
    if empty.is_symlink() or any(empty.iterdir()): raise RuntimeError("Runner trust CA directory is not isolated and empty")
    github_env = Path(github_env)
    if github_env.is_symlink() or (github_env.exists() and not github_env.is_file()): raise RuntimeError("GITHUB_ENV is not a regular file")
    config_root = root / "package-manager-config"
    config_root.mkdir(mode=0o700)
    config = config_root / ".bunfig.toml"
    with config.open("x", encoding="utf-8") as output:
        output.write("[install]\ncafile = " + json.dumps(str(ca)) + "\n")
    config.chmod(0o600)
    exports = {name: empty if name in ("SSL_CERT_DIR", "GIT_SSL_CAPATH") else ca for name in EXPORTS}
    # A nonempty CURL_CA_BUNDLE suppresses curl's SSL_CERT_DIR override.
    exports["CURL_CA_BUNDLE"] = ""
    exports["XDG_CONFIG_HOME"] = config_root
    if os.name == "nt":
        exports.update({"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.schannelUseSSLCAInfo", "GIT_CONFIG_VALUE_0": "true"})
    with github_env.open("a", encoding="utf-8") as output:
        for name, value in exports.items():
            rendered = str(value)
            if "\n" in rendered or "\r" in rendered: raise RuntimeError("Runner trust path contains a newline")
            output.write(f"{name}={rendered}\n")
    print(f"Prepared maintained runner trust ({root_count} roots, {BUNDLE_SHA256}).")
    return ca, empty, exports
if __name__ == "__main__":
    prepare(download(), os.environ["RUNNER_TEMP"], os.environ["GITHUB_ENV"])
    if os.name == "nt": restrict_windows_roots()'''


BOOTSTRAP_NAME = "Prepare maintained runner trust before network access"
NODE_OPTIONS = "--use-openssl-ca"
EXEMPT_JOBS = {("ci.yml", "ci")}


def workflow_run() -> str:
    return "python_cmd=python3\ncommand -v \"$python_cmd\" >/dev/null || python_cmd=python\n\"$python_cmd\" - <<'PY'\n" + INLINE_PROGRAM.rstrip("\n") + "\nPY\n"


def workflow_step(indent: str = "      ", *, anchor: bool = True) -> list[str]:
    lines = [
        indent + ("- &runner_trust\n" if anchor else "- *runner_trust\n"),
    ]
    if not anchor:
        return lines
    lines.extend([
        indent + f"  name: {BOOTSTRAP_NAME}\n",
        indent + "  shell: bash\n",
        indent + "  working-directory: ${{ github.workspace }}\n",
        indent + "  run: |\n",
    ])
    lines.extend((indent + "    " + line if line else "") + "\n"
                 for line in workflow_run().rstrip("\n").split("\n"))
    return lines


def workflow_files(root: Path) -> list[Path]:
    return sorted((root / ".github" / "workflows").glob("*.yml"))


def job_blocks(lines: list[str]) -> list[tuple[str, int, int, int]]:
    try:
        jobs_line = lines.index("jobs:\n")
    except ValueError as error:
        raise RuntimeError("Workflow has no top-level jobs mapping") from error
    headings = [
        (match.group(1), index)
        for index, line in enumerate(lines[jobs_line + 1 :], jobs_line + 1)
        if (match := re.fullmatch(r"  ([A-Za-z0-9_-]+):\s*\n", line))
    ]
    blocks = []
    for offset, (name, start) in enumerate(headings):
        end = headings[offset + 1][1] if offset + 1 < len(headings) else len(lines)
        steps = next((index for index in range(start, end) if lines[index] == "    steps:\n"), -1)
        if steps < 0:
            raise RuntimeError(f"Job {name} has no directly declared steps")
        blocks.append((name, start, end, steps))
    return blocks


def ensure_node_options(lines: list[str]) -> list[str]:
    for index, line in enumerate(lines):
        if line == "env:\n":
            end = next((cursor for cursor in range(index + 1, len(lines))
                        if lines[cursor] and not lines[cursor].startswith((" ", "\n"))), len(lines))
            if any(candidate.startswith("  NODE_OPTIONS:") for candidate in lines[index + 1 : end]):
                return lines
            lines.insert(index + 1, f"  NODE_OPTIONS: {NODE_OPTIONS}\n")
            return lines
    jobs = lines.index("jobs:\n")
    lines[jobs:jobs] = ["env:\n", f"  NODE_OPTIONS: {NODE_OPTIONS}\n", "\n"]
    return lines


def update_workflow(path: Path) -> bool:
    lines = path.read_text().splitlines(keepends=True)
    lines = ensure_node_options(lines)
    lines = [re.sub(r"(NODE_OPTIONS: )(?!.*--use-openssl-ca)(.*)", r"\1--use-openssl-ca \2", line) for line in lines]
    anchor = workflow_step(anchor=True)
    alias = workflow_step(anchor=False)
    replacements = []
    declared = False
    for name, _start, _end, steps in job_blocks(lines):
        if (path.name, name) in EXEMPT_JOBS:
            continue
        expected = anchor if not declared else alias
        declared = True
        if lines[steps + 1 : steps + 1 + len(expected)] == expected:
            continue
        first = steps + 1
        if first < len(lines) and lines[first] in {
            f"      - name: {BOOTSTRAP_NAME}\n",
            "      - &runner_trust\n",
            "      - *runner_trust\n",
        }:
            end = next((cursor for cursor in range(first + 1, len(lines))
                        if re.match(r"^      - ", lines[cursor])), _end)
            replacements.append((first, end, expected))
        else:
            replacements.append((first, first, expected))
    for start, end, expected in reversed(replacements):
        lines[start:end] = expected
    updated = "".join(lines)
    original = path.read_text()
    if updated == original:
        return False
    path.write_text(updated)
    return True


def check_workflows(root: Path) -> tuple[int, int]:
    files = workflow_files(root)
    jobs = 0
    protected = 0
    for path in files:
        lines = path.read_text().splitlines(keepends=True)
        text = "".join(lines)
        if "env:\n  NODE_OPTIONS: --use-openssl-ca\n" not in text:
            raise RuntimeError(f"{path.name} lacks normal workflow NODE_OPTIONS policy")
        if "GITHUB_ENV" in text and re.search(r"NODE_OPTIONS.*GITHUB_ENV|GITHUB_ENV.*NODE_OPTIONS", text):
            raise RuntimeError(f"{path.name} attempts to export prohibited NODE_OPTIONS")
        for line in lines:
            if "NODE_OPTIONS:" in line and "--use-openssl-ca" not in line:
                raise RuntimeError(f"{path.name} overrides NODE_OPTIONS without maintained trust")
        declared = False
        for name, _start, _end, steps in job_blocks(lines):
            jobs += 1
            if (path.name, name) in EXEMPT_JOBS:
                if lines[steps + 1] in {"      - &runner_trust\n", "      - *runner_trust\n"}:
                    raise RuntimeError(f"{path.name}:{name} unexpectedly duplicates the network bootstrap")
                continue
            expected = workflow_step(anchor=not declared)
            declared = True
            if lines[steps + 1 : steps + 1 + len(expected)] != expected:
                raise RuntimeError(f"{path.name}:{name} does not start with the canonical trust bootstrap")
            protected += 1
        if text.count("&runner_trust") != 1:
            raise RuntimeError(f"{path.name} must declare the runner trust anchor exactly once")
    return jobs, protected


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--emit-workflow-step", action="store_true")
    parser.add_argument("--write-workflows", action="store_true")
    parser.add_argument("--check-workflows", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    selected = sum((args.emit_workflow_step, args.write_workflows, args.check_workflows))
    if selected != 1:
        parser.error("select exactly one operation")
    if args.emit_workflow_step:
        sys.stdout.write("".join(workflow_step(anchor=True)))
    elif args.write_workflows:
        changed = [path for path in workflow_files(root) if update_workflow(path)]
        print(f"Updated {len(changed)} workflows.")
    else:
        jobs, protected = check_workflows(root)
        print(f"Runner trust policy covers {protected} of {jobs} jobs; one local-only job is exempt.")


if __name__ == "__main__":
    main()
