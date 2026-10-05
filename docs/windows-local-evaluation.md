# Windows x64 local evaluation

This page defines the current Windows x64 source-build boundary. It is a
contributor evaluation, not a qualified Windows release or a LAN deployment.
The local server and Desktop have been observed through the sign-in screen.
Owner sign-in, a model-backed action, the installed NSIS package, and
Windows-specific device tools have not been accepted.

## Prerequisites

- Windows x64 and native PowerShell 7.
- Bun **1.3.11**, matching `.bun-version`, and Node **24.x**. Check both exact
  versions before running repository scripts.
- Docker Desktop with the Linux engine running. `docker version` must show both
  Client and Server, and `docker compose version` must work. Docker Desktop's
  integration with an ordinary Ubuntu WSL distribution is optional for commands
  issued from Windows; disabling a broken distro integration does not disable
  Docker Desktop's own Linux engine. Do not run the repository through WSL.
- Visual Studio C++ build tools for x64. The `package:win` build requires
  **C++ Spectre-mitigated libraries for x64/x86** for the selected toolset.
  Missing libraries produce `MSB8040` while rebuilding `node-pty`.
- A fresh, named Nautilo instance. Inspect existing instances and Docker
  containers before starting one; the default instance may contain real data.

## Install dependencies

Use a normal PowerShell 7 terminal in the repository root:

```powershell
$repoPath = 'C:\path\to\nautilo'
Set-Location -LiteralPath $repoPath
bun install --frozen-lockfile
```

The first-party app installer selects Bun's isolated linker on Windows. This
avoids the pinned Bun runtime's `EPERM` and nested-directory `ENOENT` failures
with local `file:` dependencies. Writer and Video remain available.
Server startup snapshots each resolved package once and retains dependency
edges within the installed app. This preserves different package versions and
cycles outside the source checkout.
Administrator permissions are not required for this install. The standard
command passed locally after recreating all first-party dependency folders;
the existing root workspace dependencies were retained. All lockfiles stayed
unchanged.

The root install prepares production dependencies for these apps. For Writer
or Video development, run `bun install --frozen-lockfile --omit=peer
--linker=isolated` in that app's directory before running its typechecks or
tests. This also installs its declared development tools.

## Start the server

Use PowerShell 7 in the repository root. Keep this terminal open while testing.

```powershell
$repoPath = 'C:\path\to\nautilo'
$instanceName = 'solo-win'
Set-Location -LiteralPath $repoPath
bun run dev-stack --instance $instanceName
```

The named instance allocates its own ports. Read its printed **server URL**;
do not copy a port from another machine. Check `/health` and `/` on that URL.
The Workbench is served by the Nautilo server; there is no separate production
Workbench process. This local profile advertises `localhost` and cannot be
made into a LAN server by opening its ports or replacing the hostname later.

## Create the first owner

There is no default username or password, and no external Nautilo account is
required. The first run writes a single-use invitation to
`%USERPROFILE%\.nautilo-<instance-name>\claim-invite.txt`. Keep it private.

1. Open that file in a text editor on the server PC. A new file includes
   `redeem_url`; copy its complete URL into a normal browser. An older file may
   contain only `redeem_input: inv_...`. In that case, open the printed server
   URL followed by `/claim#claim=` and then paste **only** the `inv_...` value
   after the equals sign. Do not add spaces or paste the code into chat.
2. On **Set up your Nautilo server**, choose a handle. Follow the account
   registration to set its password. Then enter a display name and a separate
   6–8 digit approval PIN.
3. Save the one-time recovery codes before continuing. The PIN is for
   approvals; it is not the sign-in password.

If Desktop already shows two windows, leave them open during the claim. The
larger **Nautilo — Setup** window is the connection flow; the smaller **Sign in
to Nautilo** window is the login form. After claiming the server in a normal
browser, return to the smaller window and sign in with the handle and password
you just created. If that dialog no longer works, close only the login dialog
and reconnect to the same discovered server URL.

## Build and open Desktop

From `apps/desktop`, run its Windows packaging entry point:

```powershell
$desktopPath = 'C:\path\to\nautilo\apps\desktop'
Set-Location -LiteralPath $desktopPath
bun run package:win
```

It builds and bundles the private Relay Host with Bun. It produces
`release\win-unpacked\Nautilo.exe` and
`release\Nautilo Setup 0.0.0-dev.exe`. The unpacked executable can reach the
local Logto sign-in window. The NSIS installer has not been installed or
qualified. In the first-run picker, select the discovered
named server or enter its exact printed URL. Desktop connects to the server;
it does not contain a database or start the server itself.

## Known limits of this Windows result

- The Windows workflow has not yet run on a hosted runner.
- The root `bun run typecheck` script uses POSIX environment-assignment syntax
  and fails before TypeScript starts in native PowerShell on Windows. Package
  typechecks for `@nautilo/dev-tools`, `@nautilo/db`, and `@nautilo/desktop`
  passed separately; that is not a substitute for the repository-wide check.
- The server OfficeCLI manifest has no `win-x64` artifact; startup reported that
  OfficeCLI provisioning was skipped. Office-dependent behavior is unverified.
- ACP-backed Hermes and OpenCode execution is not advertised on Windows. The
  process-tree containment required by that feature is unavailable; allowing
  those hosts to start would weaken its safety boundary.
- The browser-facing client and Desktop sign-in were observed, but a completed
  owner login and useful model response were not tested. Add one model provider
  key under **Server admin → API Keys** after claiming the server to check that
  path.
- This path is loopback-only. LAN clients, Mobile, and a hosted HTTPS setup
  need their own deployment and acceptance work.

These are validation limits, not instructions to disable checks or bypass
missing runtime components.

## Windows CI

`.github/workflows/windows-desktop.yml` runs on the Windows 2025 image with
Visual Studio 2026 for pull requests that touch relevant source and on manual
dispatch. It checks the pinned toolchain, frozen install, package typechecks,
first-party install and seeding tests, Writer and Video builds and unit tests,
`package:win`, a packaged Relay Host launch test, and a hidden Desktop boot
smoke. It installs each app's
development dependencies before its contributor checks. The smoke does not
claim an owner or run a local Docker server. The Writer DOCX/OfficeCLI
integration test remains a separate opt-in check. A local YAML check and
packaged smoke pass do not substitute for a hosted workflow run.
