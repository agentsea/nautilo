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
from unittest import mock
from types import SimpleNamespace


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
    def test_git_certificate_errors_are_distinct_from_transport_failures(self):
        spec = importlib.util.spec_from_file_location("runner_client_probe", ROOT / "dev/scripts/verify-runner-trust.py")
        client = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(client)
        for message in (
            "schannel: the certificate chain is incomplete",
            "SSL certificate problem: unable to get local issuer certificate",
            "server certificate verification failed",
        ):
            with self.subTest(message=message), mock.patch.object(client, "command", return_value=SimpleNamespace(returncode=128, stderr=message)):
                self.assertEqual(client.git_tls("example.invalid"), "rejected")
        for message in ("Could not resolve host", "Connection reset by peer", "TLS handshake failed"):
            with self.subTest(message=message), mock.patch.object(client, "command", return_value=SimpleNamespace(returncode=128, stderr=message)):
                with self.assertRaisesRegex(RuntimeError, "Git transport failed"):
                    client.git_tls("example.invalid")

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
                "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH", "CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE",
                "AWS_CA_BUNDLE", "npm_config_cafile", "XDG_CONFIG_HOME",
            }
            if os.name == "nt":
                expected_exports.update({"GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"})
                self.assertEqual(exports["GIT_CONFIG_COUNT"], "1")
                self.assertEqual(exports["GIT_CONFIG_KEY_0"], "http.schannelUseSSLCAInfo")
                self.assertEqual(exports["GIT_CONFIG_VALUE_0"], "true")
            self.assertEqual(set(exports), expected_exports)
            self.assertEqual(exports["CURL_CA_BUNDLE"], "")
            self.assertEqual(exports["GIT_SSL_CAPATH"], empty)
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

    def test_windows_native_repair_is_scoped_and_fail_closed(self):
        required = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Windows"}
        namespace = inline_namespace()
        for key in required:
            environment = {**required, key: "unexpected"}
            namespace["os"] = SimpleNamespace(name="nt", environ=environment)
            with mock.patch.object(namespace["subprocess"], "run") as run:
                with self.assertRaisesRegex(RuntimeError, "ephemeral GitHub-hosted Windows"):
                    namespace["restrict_windows_roots"]()
                run.assert_not_called()
        namespace["os"] = SimpleNamespace(name="posix", environ=required)
        with self.assertRaises(RuntimeError):
            namespace["restrict_windows_roots"]()
        namespace["os"] = SimpleNamespace(name="nt", environ=required)
        with mock.patch.object(namespace["subprocess"], "run") as run:
            namespace["restrict_windows_roots"]()
        self.assertEqual(run.call_count, 2)
        powershell = run.call_args_list[0].args[0]
        self.assertEqual(powershell[:5], ["pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
        script = powershell[-1]
        self.assertIn("HashAlgorithmName]::SHA256", script)
        self.assertNotIn(".Thumbprint", script)
        self.assertNotIn(".Clear(", script)
        self.assertIn("@('LocalMachine', 'CurrentUser')", script)
        self.assertIn("@('Root', 'CA')", script)
        self.assertIn("'Disallowed'", script)
        self.assertLess(script.index("$store.Add("), script.index("$store.Remove("))
        self.assertIn("$blocked -contains (Fingerprint $certificate)", script)
        fresh_python = run.call_args_list[1].args[0]
        self.assertIn("ssl.enum_certificates(name)", fresh_python[2])
        self.assertEqual(set(json.loads(fresh_python[3])), BLOCKED)
        for call in run.call_args_list:
            self.assertTrue(call.kwargs["check"])
            self.assertGreater(call.kwargs["timeout"], 0)

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
