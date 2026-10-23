#!/usr/bin/env python3
"""Run the locked Bun install with Socket Firewall's scoped session CA."""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import ssl
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from collections.abc import Iterable


BASE_SHA256 = "5961c0a3c65459931c023e0075c09733f09aea4ca439cb85bc4a08bb4f3f568b"
DENIED_ROOTS = {
    "7dd78d5f4f13459a83dff9abbba62edbaf6f2d102bf257fd712f4d9f2746ed8d",
    "86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b",
    "d7a7a0fb5d7e2731d771e9484ebcdef71d5f0c3e0a2948782bc83ee0ea699ef4",
}
PEM = re.compile(rb"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", re.S)
SOCKET_DN = {
    ("commonName", "Socket Security CA"),
    ("organizationName", "Socket Security"),
}


def _certificates(bundle: bytes, label: str) -> list[tuple[bytes, bytes]]:
    matches = PEM.findall(bundle)
    if not matches or PEM.sub(b"", bundle).strip():
        raise RuntimeError(f"{label} is empty or malformed")
    parsed = []
    for certificate in matches:
        try:
            der = ssl.PEM_cert_to_DER_cert(certificate.decode("ascii"))
        except (UnicodeDecodeError, ValueError) as error:
            raise RuntimeError(f"{label} contains a malformed certificate") from error
        parsed.append((certificate, der))
    try:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.load_verify_locations(cadata=bundle.decode("ascii"))
    except (UnicodeDecodeError, ValueError, ssl.SSLError) as error:
        raise RuntimeError(f"{label} contains a malformed certificate") from error
    return parsed


def _fingerprint(der: bytes) -> str:
    return hashlib.sha256(der).hexdigest()


def _dn(entries: Iterable[Iterable[tuple[str, str]]]) -> set[tuple[str, str]]:
    return {
        (str(key), str(value))
        for relative_name in entries
        for key, value in relative_name
    }


def qualify_base(path: Path) -> bytes:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise RuntimeError("Maintained CA bundle is not an absolute regular file")
    bundle = path.read_bytes()
    if hashlib.sha256(bundle).hexdigest() != BASE_SHA256:
        raise RuntimeError("Maintained CA bundle hash mismatch")
    parsed = _certificates(bundle, "Maintained CA bundle")
    exposed = sorted(DENIED_ROOTS & {_fingerprint(der) for _pem, der in parsed})
    if exposed:
        raise RuntimeError("Maintained CA bundle contains denied roots: " + ", ".join(exposed))
    return bundle


def qualify_session(path_text: str, workspace: Path | None = None) -> bytes:
    if not path_text:
        raise RuntimeError("Socket Firewall did not provide NODE_EXTRA_CA_CERTS")
    path = Path(path_text)
    if not path.is_absolute() or path.name != "socketFirewallCa.crt":
        raise RuntimeError("Socket Firewall session CA path is unexpected")
    parent = path.parent
    if parent.parent != Path("/tmp") or not parent.name.startswith("sfw-"):
        raise RuntimeError("Socket Firewall session CA is outside its private /tmp directory")
    if path.is_symlink() or parent.is_symlink():
        raise RuntimeError("Socket Firewall session CA path may not contain symlinks")
    try:
        file_info = path.stat()
        parent_info = parent.stat()
    except FileNotFoundError as error:
        raise RuntimeError("Socket Firewall session CA is missing") from error
    if not stat.S_ISREG(file_info.st_mode) or not stat.S_ISDIR(parent_info.st_mode):
        raise RuntimeError("Socket Firewall session CA is not a regular file in a directory")
    if file_info.st_uid != os.getuid() or parent_info.st_uid != os.getuid():
        raise RuntimeError("Socket Firewall session CA is not owned by the current user")
    if file_info.st_mode & 0o022 or parent_info.st_mode & 0o077:
        raise RuntimeError("Socket Firewall session CA permissions are too broad")
    if workspace is not None:
        resolved_workspace = workspace.resolve()
        try:
            path.resolve().relative_to(resolved_workspace)
        except ValueError:
            pass
        else:
            raise RuntimeError("Socket Firewall session CA may not come from the workspace")
    if file_info.st_size <= 0 or file_info.st_size > 64 * 1024:
        raise RuntimeError("Socket Firewall session CA has an invalid size")

    bundle = path.read_bytes()
    parsed = _certificates(bundle, "Socket Firewall session CA")
    if len(parsed) != 1:
        raise RuntimeError("Socket Firewall session CA must contain exactly one certificate")
    _pem, der = parsed[0]
    fingerprint = _fingerprint(der)
    if fingerprint in DENIED_ROOTS:
        raise RuntimeError("Socket Firewall session CA matches a denied root")

    decoded = ssl._ssl._test_decode_cert(str(path))
    if _dn(decoded.get("subject", ())) != SOCKET_DN or _dn(decoded.get("issuer", ())) != SOCKET_DN:
        raise RuntimeError("Socket Firewall session CA has an unexpected identity")
    now = time.time()
    if not (
        ssl.cert_time_to_seconds(decoded["notBefore"]) <= now
        < ssl.cert_time_to_seconds(decoded["notAfter"])
    ):
        raise RuntimeError("Socket Firewall session CA is outside its validity period")

    verify = subprocess.run(
        [
            "openssl",
            "verify",
            "-no-CAfile",
            "-no-CApath",
            "-no-CAstore",
            "-trusted",
            str(path),
            "-check_ss_sig",
            str(path),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=15,
    )
    if verify.returncode != 0:
        raise RuntimeError("Socket Firewall session CA failed self-signature verification")
    constraints = subprocess.run(
        ["openssl", "x509", "-in", str(path), "-noout", "-ext", "basicConstraints"],
        check=False,
        capture_output=True,
        text=True,
        timeout=15,
    )
    if constraints.returncode != 0 or "CA:TRUE" not in constraints.stdout.replace(" ", ""):
        raise RuntimeError("Socket Firewall session certificate is not a CA")
    return bundle


def run(base_path: Path, command: list[str]) -> int:
    if len(command) < 2 or Path(command[0]).name != "bun" or command[1] != "install":
        raise RuntimeError("Socket trust wrapper only permits bun install")
    if any(argument == "--cafile" or argument.startswith("--cafile=") for argument in command):
        raise RuntimeError("Socket trust wrapper owns Bun's cafile")

    base = qualify_base(base_path)
    workspace_text = os.environ.get("GITHUB_WORKSPACE")
    workspace = Path(workspace_text) if workspace_text else None
    session = qualify_session(os.environ.get("NODE_EXTRA_CA_CERTS", ""), workspace)
    runner_temp = Path(os.environ.get("RUNNER_TEMP", tempfile.gettempdir()))
    if runner_temp.is_symlink() or not runner_temp.is_dir():
        raise RuntimeError("Runner temporary directory is not a real directory")

    descriptor, composed_text = tempfile.mkstemp(
        prefix="nautilo-sfw-", suffix=".crt", dir=runner_temp
    )
    composed = Path(composed_text)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(base)
            if not base.endswith(b"\n"):
                output.write(b"\n")
            output.write(session)
            output.write(b"\n")
        composed.chmod(0o600)
        environment = os.environ.copy()
        environment["SSL_CERT_FILE"] = str(composed)
        environment["NODE_EXTRA_CA_CERTS"] = str(composed)
        guarded = [*command, f"--cafile={composed}"]
        return subprocess.run(guarded, env=environment, check=False).returncode
    finally:
        composed.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-ca", required=True, type=Path)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    arguments = parser.parse_args(argv)
    command = arguments.command
    if command and command[0] == "--":
        command = command[1:]
    try:
        return run(arguments.base_ca, command)
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Socket trust wrapper refused to run: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
