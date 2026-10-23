// Execute inside the final image as its configured root user with no network.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import tls from 'node:tls';
import process from 'node:process';
import { log } from 'node:console';
import { spawnSync } from 'node:child_process';

/** @param {string} path */
function readVersion(path) {
  /** @type {unknown} */
  const metadata = JSON.parse(fs.readFileSync(path, 'utf8'));
  assert.ok(metadata !== null && typeof metadata === 'object' && 'version' in metadata);
  return metadata.version;
}

const caBundlePath = '/etc/ssl/certs/ca-certificates.crt';
const emptyCertificateDirectory = '/etc/ssl/nautilo-empty-certs';
const expectedBundleSha256 = '5961c0a3c65459931c023e0075c09733f09aea4ca439cb85bc4a08bb4f3f568b';
const distrustedRootFingerprints = new Set([
  '7dd78d5f4f13459a83dff9abbba62edbaf6f2d102bf257fd712f4d9f2746ed8d',
  '86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b',
  'd7a7a0fb5d7e2731d771e9484ebcdef71d5f0c3e0a2948782bc83ee0ea699ef4',
]);

assert.equal(process.versions.node, '22.23.4');
assert.ok(['x64', 'arm64'].includes(process.arch), `Unsupported runtime architecture: ${process.arch}`);
assert.equal(process.cwd(), '/etc/logto');
assert.equal(readVersion('/etc/logto/packages/core/package.json'), '1.38.0');
assert.equal(readVersion('/etc/logto/packages/cli/package.json'), '1.38.0');
assert.equal(process.env.YARN_VERSION, '1.22.22');
assert.equal(process.env.NODE_OPTIONS, '--use-openssl-ca');
assert.equal(process.env.SSL_CERT_FILE, caBundlePath);
assert.equal(process.env.SSL_CERT_DIR, emptyCertificateDirectory);
assert.equal(process.env.NAUTILO_CA_CERTIFICATES_PACKAGE, 'alpine:20261020-r0');
assert.equal(process.env.NAUTILO_CA_BUNDLE_SHA256, expectedBundleSha256);

const emptyDirectoryStat = fs.lstatSync(emptyCertificateDirectory);
assert.equal(emptyDirectoryStat.isSymbolicLink(), false);
assert.equal(emptyDirectoryStat.isDirectory(), true);
assert.deepEqual(fs.readdirSync(emptyCertificateDirectory), []);

const caBundle = fs.readFileSync(caBundlePath, 'utf8');
const bundleSha256 = crypto.createHash('sha256').update(caBundle).digest('hex');
assert.equal(bundleSha256, expectedBundleSha256);
const certificates = caBundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu) ?? [];
assert.ok(certificates.length > 0, 'Runtime CA bundle is empty');
const fingerprints = new Set(certificates.map((certificate) =>
  new crypto.X509Certificate(certificate).fingerprint256.replaceAll(':', '').toLowerCase()));
for (const fingerprint of distrustedRootFingerprints) {
  assert.equal(fingerprints.has(fingerprint), false, 'Distrusted TLS root remains in runtime CA bundle');
}

// Loading both an explicit and the process-default context catches malformed
// bundle bytes and confirms OpenSSL can initialize its configured trust paths.
assert.doesNotThrow(() => tls.createSecureContext({ ca: caBundle }));
assert.doesNotThrow(() => tls.createSecureContext());
const packageCheck = spawnSync('apk', ['info', '-e', 'ca-certificates-bundle=20261020-r0'], {
  encoding: 'utf8',
});
assert.equal(packageCheck.error, undefined);
assert.equal(packageCheck.status, 0, packageCheck.stderr);
assert.equal(fs.existsSync('/tmp/ca-certificates-bundle.apk'), false);

log(JSON.stringify({
  logto: readVersion('/etc/logto/packages/core/package.json'),
  node: process.versions.node,
  architecture: process.arch,
  caCertificatesPackage: process.env.NAUTILO_CA_CERTIFICATES_PACKAGE,
  caBundleSha256: bundleSha256,
  certificateCount: certificates.length,
  defaultValidation: 'initialized',
}, null, 2));
