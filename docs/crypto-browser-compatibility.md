# Crypto browser compatibility

## Live Shadow Messages

Chromium is the supported Browser engine for the first live Shadow Message
milestone.

The real Browser-vault harness runs Human Message preparation, profile-v4
authentication, HPKE seal/open, and restart preparation in Chromium. The same
HPKE path is deliberately not claimed for Firefox or WebKit: with Playwright
1.62.1 and the current `@hpke/core` P-256 implementation, Firefox and WebKit
cannot complete the serialize/import/seal/open round trip for the persisted
private key (`Client profile encryption keypair is invalid`). Their existing
IndexedDB/WebCrypto vault, journal, and custody conformance suites still run.

This is a release limitation, not a silent test exclusion. On Firefox and
WebKit, cryptographic preparation fails closed and the ordinary Message path
remains available. Those engines are unsupported for live Shadow Message
activation until the KEM path is made portable and the same
`live-shadow-human-prepare-restart` check passes in all three engines.
