#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("install_with_socket_trust.py")
SPEC = importlib.util.spec_from_file_location("install_with_socket_trust", SCRIPT)
assert SPEC and SPEC.loader
POLICY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLICY)


def certificate(directory: Path, name: str, subject: str, *, ca: bool = True) -> Path:
    path = directory / f"{name}.crt"
    key = directory / f"{name}.key"
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
            "-days", "2", "-keyout", str(key), "-out", str(path), "-subj", subject,
            "-addext", f"basicConstraints=critical,CA:{'TRUE' if ca else 'FALSE'}",
        ],
        check=True,
        capture_output=True,
        timeout=30,
    )
    return path


class SocketTrustTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.base = certificate(self.root, "base", "/CN=Maintained Test Root/O=Nautilo Test")
        self.session_parent = Path("/tmp") / f"sfw-nautilo-test-{os.getpid()}-{id(self)}"
        self.session_parent.mkdir(mode=0o700)
        self.session = certificate(
            self.session_parent, "socketFirewallCa", "/CN=Socket Security CA/O=Socket Security"
        )
        self.session.chmod(0o600)
        self.session = self.session.with_name("socketFirewallCa.crt")
        self.fake_bun = self.root / "bun"
        self.capture = self.root / "captured.crt"
        self.fake_bun.write_text(
            "#!/bin/sh\n"
            "cp \"$SSL_CERT_FILE\" \"$CAPTURE_BUNDLE\"\n"
            "test \"$SSL_CERT_FILE\" = \"$NODE_EXTRA_CA_CERTS\"\n"
            "case \" $* \" in *\" --cafile=\"*) ;; *) exit 90;; esac\n"
            "exit \"${FAKE_EXIT:-0}\"\n",
            encoding="utf-8",
        )
        self.fake_bun.chmod(0o700)
        self.environment = {
            "NODE_EXTRA_CA_CERTS": str(self.session),
            "SSL_CERT_FILE": str(self.root / "broad-runner-bundle.crt"),
            "RUNNER_TEMP": str(self.root),
            "GITHUB_WORKSPACE": str(self.root / "workspace"),
            "CAPTURE_BUNDLE": str(self.capture),
        }
        (self.root / "workspace").mkdir()
        (self.root / "broad-runner-bundle.crt").write_bytes(
            self.base.read_bytes() + certificate(self.root, "runner-extra", "/CN=Runner Extra").read_bytes()
        )
        self.base_hash = hashlib.sha256(self.base.read_bytes()).hexdigest()

    def tearDown(self):
        for path in self.session_parent.iterdir():
            path.unlink()
        self.session_parent.rmdir()
        self.temporary.cleanup()

    def run_policy(self, *, exit_code: int = 0) -> int:
        environment = {**os.environ, **self.environment, "FAKE_EXIT": str(exit_code)}
        with mock.patch.object(POLICY, "BASE_SHA256", self.base_hash), mock.patch.dict(
            os.environ, environment, clear=True
        ):
            return POLICY.run(self.base, [str(self.fake_bun), "install", "--frozen-lockfile"])

    def test_composes_only_maintained_and_session_roots(self):
        self.assertEqual(self.run_policy(), 0)
        captured = self.capture.read_bytes()
        certificates = POLICY._certificates(captured, "captured bundle")
        self.assertEqual(len(certificates), 2)
        expected = {hashlib.sha256(der).hexdigest() for source in (self.base, self.session)
                    for _pem, der in POLICY._certificates(source.read_bytes(), "expected root")}
        self.assertEqual({hashlib.sha256(der).hexdigest() for _pem, der in certificates}, expected)
        self.assertFalse(list(self.root.glob("nautilo-sfw-*.crt")))

    def test_rejects_bad_maintained_bundle_hash(self):
        with mock.patch.dict(os.environ, {**os.environ, **self.environment}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "hash mismatch"):
                POLICY.run(self.base, [str(self.fake_bun), "install"])
        self.assertFalse(self.capture.exists())

    def test_rejects_malformed_or_non_ca_session(self):
        self.session.write_text("not a certificate", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "empty or malformed"):
            self.run_policy()
        replacement = certificate(self.session_parent, "replacement", "/CN=Socket Security CA/O=Socket Security", ca=False)
        self.session.write_bytes(replacement.read_bytes())
        with self.assertRaisesRegex(RuntimeError, "not a CA"):
            self.run_policy()

    def test_preserves_failure_exit_and_removes_composed_bundle(self):
        self.assertEqual(self.run_policy(exit_code=37), 37)
        self.assertTrue(self.capture.is_file())
        self.assertFalse(list(self.root.glob("nautilo-sfw-*.crt")))

    def test_rejects_a_broad_session_bundle_or_foreign_ca_identity(self):
        self.session.write_bytes(self.session.read_bytes() + self.base.read_bytes())
        with self.assertRaisesRegex(RuntimeError, "exactly one certificate"):
            self.run_policy()
        foreign = certificate(self.session_parent, "foreign", "/CN=Unrelated Root")
        self.session.write_bytes(foreign.read_bytes())
        with self.assertRaisesRegex(RuntimeError, "unexpected identity"):
            self.run_policy()
        self.assertFalse(self.capture.exists())

    def test_rejects_an_unprotected_session_directory(self):
        self.session_parent.chmod(0o755)
        with self.assertRaisesRegex(RuntimeError, "permissions are too broad"):
            self.run_policy()
        self.assertFalse(self.capture.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
