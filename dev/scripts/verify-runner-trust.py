#!/usr/bin/env python3
"""Credential-free qualification of the configured runner network clients."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile

INCIDENT_HOSTS = [f"{kind}-{group}{cross}-emudhra.we-have-a-problem.com"
                  for kind in ("dv", "ov", "ev") for group in ("g3b", "g3c")
                  for cross in ("", "-aaa")]
CERTIFICATE_ERRORS = ("certificate_verify_failed", "unable_to_get_issuer_cert_locally",
                      "unable_to_verify_leaf_signature", "cert_revoked", "cert_untrusted")


def command(arguments, *, cwd=None):
    # No registry, provider or GitHub credential is needed for this probe.
    environment = {key: value for key, value in os.environ.items()
                   if not any(part in key.upper() for part in ("TOKEN", "SECRET", "PASSWORD", "API_KEY"))}
    environment["GIT_TERMINAL_PROMPT"] = "0"
    return subprocess.run(arguments, cwd=cwd, env=environment,
                          capture_output=True, text=True, timeout=45)


def python_tls(host):
    context = ssl.create_default_context()
    try:
        with socket.create_connection((host, 443), timeout=15) as plain:
            with context.wrap_socket(plain, server_hostname=host):
                return "accepted"
    except ssl.SSLCertVerificationError:
        return "rejected"


def curl_tls(host):
    # Schannel ignores CURL_CA_BUNDLE; select the exclusive file policy explicitly.
    native_options = (["--cacert", os.environ["SSL_CERT_FILE"], "--no-ca-native"]
                      if os.name == "nt" else [])
    result = command(["curl", "--disable", *native_options, "--silent", "--show-error", "--max-time", "30",
                      "--output", os.devnull, "https://" + host])
    if result.returncode == 60:
        return "rejected"
    if result.returncode == 0:
        return "accepted"
    raise RuntimeError("curl transport failed: " + result.stderr[-300:])


def git_tls(host):
    url = ("https://github.com/octocat/Hello-World.git" if host == "github.com"
           else "https://" + host + "/runner-trust-probe.git")
    result = command(["git", "-c", "credential.helper=", "-c", "http.extraHeader=",
                      "-c", "http.sslVerify=true", "ls-remote", "--heads", url])
    error = result.stderr.lower()
    if result.returncode and ("certificate" in error and any(
            term in error for term in ("verify", "verification", "issuer", "untrusted", "revoked", "the certificate chain is incomplete"))):
        return "rejected"
    if result.returncode == 0 or any(term in error for term in ("repository not found", "not a git repository")):
        return "accepted"
    raise RuntimeError("Git transport failed: " + result.stderr[-300:])


def bun_package_manager(host):
    with tempfile.TemporaryDirectory(prefix="runner-trust-pm-") as directory:
        result = command(["bun", "install", "is-number@7.0.0", "--no-save", "--no-cache",
                          "--ignore-scripts", "--registry", "https://" + host], cwd=directory)
    output = (result.stdout + result.stderr).lower()
    if result.returncode and any(error in output for error in CERTIFICATE_ERRORS):
        return "rejected"
    if result.returncode == 0 or "packagefailedtoparse" in output:
        return "accepted"
    raise RuntimeError("Bun package-manager request failed: " + output[-300:])


def qualify_client(name, probe, healthy):
    hosts = INCIDENT_HOSTS + [healthy]
    with ThreadPoolExecutor(max_workers=4) as executor:
        outcomes = dict(zip(hosts, executor.map(probe, hosts)))
    if any(outcomes[host] != "rejected" for host in INCIDENT_HOSTS) or outcomes[healthy] != "accepted":
        raise RuntimeError(name + " trust qualification failed: " + json.dumps(outcomes))
    print(json.dumps({"client": name, "incidentRejected": len(INCIDENT_HOSTS), "healthyAccepted": 1}))


def main():
    bundle = Path(os.environ["SSL_CERT_FILE"])
    empty = Path(os.environ["SSL_CERT_DIR"])
    if not bundle.is_file() or not empty.is_dir() or any(empty.iterdir()):
        raise RuntimeError("Configured runner trust is missing")
    qualify_client("Python default environment trust", python_tls, "example.com")
    qualify_client("curl explicit CA file" if os.name == "nt" else "curl environment CA", curl_tls, "example.com")
    qualify_client("Git", git_tls, "github.com")
    if command(["bun", "--version"]).stdout.strip() != "1.4.4":
        raise RuntimeError("Package-manager qualification requires the exact CI Bun pin")
    qualify_client("Bun package manager global CA", bun_package_manager, "registry.npmjs.org")
    script = r'''
const https = require('node:https');
const hosts = JSON.parse(process.argv[1]);
const errors = new Set(['CERT_REVOKED','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','UNABLE_TO_VERIFY_LEAF_SIGNATURE','CERT_UNTRUSTED','SELF_SIGNED_CERT_IN_CHAIN']);
(async () => {
  for (const api of ['https', 'fetch']) {
    for (const host of [...hosts, 'example.com']) {
      let code, accepted = false;
      try {
        if (api === 'https') await new Promise((resolve, reject) => {
          const request = https.get('https://' + host, {agent:false}, response => {response.resume(); resolve();});
          request.setTimeout(15000, () => request.destroy(new Error('timeout')));
          request.on('error', reject);
        });
        else { const response = await fetch('https://' + host, {signal:AbortSignal.timeout(15000)}); await response.body?.cancel(); }
        accepted = true;
      } catch (error) { code = error.cause?.code ?? error.code; }
      if (host === 'example.com' ? !accepted : accepted || !errors.has(code)) throw new Error(api + ': unexpected trust outcome for ' + host + ': ' + code);
    }
  }
  console.log(JSON.stringify({client:'Node default https/fetch',node:process.version,incidentRejected:hosts.length*2,healthyAccepted:2}));
})().catch(error => {console.error(error.message); process.exitCode=1;});
'''
    result = command(["node", "-e", script, json.dumps(INCIDENT_HOSTS)])
    if result.returncode:
        raise RuntimeError("Node trust qualification failed: " + result.stderr[-500:])
    print(result.stdout.strip())


if __name__ == "__main__":
    main()
