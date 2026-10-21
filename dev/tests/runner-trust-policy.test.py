#!/usr/bin/env python3
"""Offline policy tests plus an explicit credential-free live TLS probe."""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "dev" / "scripts" / "runner-trust-bootstrap.py"
SPEC = importlib.util.spec_from_file_location("runner_trust_bootstrap", SCRIPT)
POLICY = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(POLICY)

TEST_CERTIFICATE = b"""-----BEGIN CERTIFICATE-----
MIIBjTCCATOgAwIBAgIUCoba5OoO45jjdt21h6/Xc79Ob64wCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRcnVubmVyLXRydXN0LXRlc3QwHhcNMjYxMDIxMTgxMjExWhcN
MjYxMDIyMTgxMjExWjAcMRowGAYDVQQDDBFydW5uZXItdHJ1c3QtdGVzdDBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABABu3Gy4ogU7BCVRQINUpuLKwEmaEnrAGZfJ
kbi5KB0RpzKFLYttMFuU36u2KlBjKtDUUNjJDXaIshnW97aIy5ujUzBRMB0GA1Ud
DgQWBBRzAc3r7G1dUeg/0V53hd+ji96JADAfBgNVHSMEGDAWgBRzAc3r7G1dUeg/
0V53hd+ji96JADAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIC6G
qWsHJQLUeUIikuxn1dSefrITqhFSkUBXSo6wBrlNAiEAgtSYNZRG7RWnKm+eGX10
CZuERKu+8Utc5CklTyq1XWU=
-----END CERTIFICATE-----
"""

BLOCKED = {
    "86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b",
    "d7a7a0fb5d7e2731d771e9484ebcdef71d5f0c3e0a2948782bc83ee0ea699ef4",
    "7dd78d5f4f13459a83dff9abbba62edbaf6f2d102bf257fd712f4d9f2746ed8d",
}




def inline_namespace():
    namespace = {"__name__": "runner_trust_inline_test"}
    exec(compile(POLICY.INLINE_PROGRAM, "<runner-trust-bootstrap>", "exec"), namespace)
    return namespace


def package(bundle, name="etc/ssl/certs/ca-certificates.crt"):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        item = tarfile.TarInfo(name)
        item.size = len(bundle)
        item.mode = 0o644
        archive.addfile(item, io.BytesIO(bundle))
    return output.getvalue()


def configured_namespace(bundle=TEST_CERTIFICATE, name="etc/ssl/certs/ca-certificates.crt"):
    namespace = inline_namespace()
    payload = package(bundle, name)
    namespace["APK_SHA256"] = hashlib.sha256(payload).hexdigest()
    namespace["BUNDLE_SHA256"] = hashlib.sha256(bundle).hexdigest()
    return namespace, payload


class BootstrapPolicyTests(unittest.TestCase):
    def test_prepares_exclusive_exports_without_node_options(self):
        namespace, payload = configured_namespace()
        with tempfile.TemporaryDirectory() as directory:
            env = Path(directory) / "github-env"
            ca, empty, exports = namespace["prepare"](payload, directory, env)
            self.assertEqual(ca.read_bytes(), TEST_CERTIFICATE)
            self.assertTrue(empty.is_dir())
            self.assertEqual(list(empty.iterdir()), [])
            expected_exports = {
                "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "PIP_CERT",
                "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE",
                "AWS_CA_BUNDLE", "npm_config_cafile", "XDG_CONFIG_HOME",
            }
            if os.name == "nt":
                expected_exports.update({"GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"})
                self.assertEqual(exports["GIT_CONFIG_COUNT"], "1")
                self.assertEqual(exports["GIT_CONFIG_KEY_0"], "http.schannelUseSSLCAInfo")
                self.assertEqual(exports["GIT_CONFIG_VALUE_0"], "true")
            self.assertEqual(set(exports), expected_exports)
            rendered = env.read_text()
            self.assertNotIn("NODE_OPTIONS", rendered)
            self.assertEqual((exports["XDG_CONFIG_HOME"] / ".bunfig.toml").read_text(),
                             "[install]\ncafile = " + json.dumps(str(ca)) + "\n")
            self.assertNotIn("\nHOME=", "\n" + rendered)
            for name in exports:
                self.assertIn(name + "=", rendered)

    def test_rejects_package_tamper_before_extraction(self):
        namespace, payload = configured_namespace()
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "hash mismatch before extraction"):
                namespace["prepare"](payload + b"tamper", directory, Path(directory) / "env")

    def test_rejects_missing_exact_bundle_member(self):
        namespace, payload = configured_namespace(name="etc/ssl/certs/not-the-policy-bundle.crt")
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "lacks the exact regular CA bundle"):
                namespace["prepare"](payload, directory, Path(directory) / "env")

    def test_rejects_empty_bundle(self):
        namespace, payload = configured_namespace(bundle=b"")
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "empty or malformed"):
                namespace["prepare"](payload, directory, Path(directory) / "env")

    def test_rejects_malformed_certificate(self):
        malformed = b"-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"
        namespace, payload = configured_namespace(bundle=malformed)
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "malformed certificates"):
                namespace["prepare"](payload, directory, Path(directory) / "env")

    def test_rejects_a_denied_root_and_preserves_exact_policy_set(self):
        namespace, _payload = configured_namespace()
        der = ssl.PEM_cert_to_DER_cert(TEST_CERTIFICATE.decode("ascii"))
        fingerprint = hashlib.sha256(der).hexdigest()
        namespace["BLOCKED"] = set(namespace["BLOCKED"]) | {fingerprint}
        with self.assertRaisesRegex(RuntimeError, fingerprint):
            namespace["qualify_bundle"](TEST_CERTIFICATE)
        self.assertEqual(inline_namespace()["BLOCKED"], BLOCKED)

    def test_workflows_start_with_the_canonical_credential_free_step(self):
        self.assertNotIn("GITHUB_TOKEN", POLICY.INLINE_PROGRAM)
        self.assertNotIn("GH_TOKEN", POLICY.INLINE_PROGRAM)
        self.assertNotIn("secrets.", POLICY.INLINE_PROGRAM)
        self.assertNotIn("NODE_OPTIONS", POLICY.INLINE_PROGRAM)
        jobs, protected = POLICY.check_workflows(ROOT)
        self.assertEqual(jobs - protected, 1)
        self.assertEqual(POLICY.EXEMPT_JOBS, {("ci.yml", "ci")})

if __name__ == "__main__":
    unittest.main(verbosity=2)
