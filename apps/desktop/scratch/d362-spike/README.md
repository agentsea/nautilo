# D362 LibreOffice First-Party Suite — Phase-0 Spike

Throwaway harness for Stack 127 / D362 Phase 0. Answers the gate: **go/no-go +
measured effort number + JSDialog-vs-fork call**. No Nautilo server / Workbench /
DB / agent — this only exercises the engine + embed + WOPI + headless shapes.

**Prerequisite: Docker running** (pulls `collabora/code` + `unoserver` images).

## Files

| File | Purpose | Task |
|---|---|---|
| `docker-compose.yml` | `collabora/code` (:9980) + `unoserver` (:2003) | 0.1, 0.4 |
| `wopi-stub.ts` | minimal WOPI host over one local file | 0.4.3 |
| `main.ts` / `preload.ts` / `run.ts` | Electron `<webview>` → Collabora + JSDialog WS tap | 0.2, 0.3 |

## FASTEST loop (proven 2026-07-02 — plain browser, no Electron)

Collabora renders in any browser; Electron is only needed to validate the
embed later. This path proved 0.1/0.2.2/0.3.3/0.4.3 end-to-end:

```bash
docker compose -f apps/desktop/scratch/d362-spike/docker-compose.yml up -d
# sample doc (generate one via unoserver if you don't have a .docx):
docker exec d362-unoserver unoconvert /tmp/x.txt /tmp/x.docx && docker cp d362-unoserver:/tmp/x.docx apps/desktop/scratch/d362-spike/sample/sample.docx
D362_DOC=apps/desktop/scratch/d362-spike/sample/sample.docx bun apps/desktop/scratch/d362-spike/wopi-stub.ts &
# editor URL: hash from `curl -s localhost:9980/hosting/discovery | grep urlsrc`
open "http://localhost:9980/browser/de013a57f9/cool.html?WOPISrc=http%3A%2F%2Fhost.docker.internal%3A8628%2Fwopi%2Ffiles%2Fspike-doc&access_token=spike-token&permission=edit"
```

Agent-driving via agent-browser works too — **use a fresh session**
(`AGENT_BROWSER_SESSION=d362`) or it inherits the stale `default` provider
(`Unknown provider 'nautilo-spike'`).

## Electron loop (validates the webview embed specifically — optional)

```bash
# 0. Put a test doc in place
mkdir -p apps/desktop/scratch/d362-spike/sample
cp <some>.docx apps/desktop/scratch/d362-spike/sample/sample.docx

# 1. Engines up (task 0.1)
docker compose -f apps/desktop/scratch/d362-spike/docker-compose.yml up
#    verify: curl -k http://localhost:9980/hosting/discovery   → WOPI discovery XML

# 2. WOPI stub (serves the sample doc to Collabora)
D362_DOC=apps/desktop/scratch/d362-spike/sample/sample.docx \
  bun apps/desktop/scratch/d362-spike/wopi-stub.ts

# 3. Electron webview → renders the doc as tiles (tasks 0.2, 0.3)
bun apps/desktop/scratch/d362-spike/run.ts
#    - edit text → watch wopi-stub log a PutFile (round-trip proof, 0.2.4)
#    - watch the runner terminal for [d362-jsdialog] frames (0.3.1)
#    - Cmd/Ctrl+Shift+I opens devtools on the webview

# 4. Headless convert/extract (task 0.4)
docker exec d362-unoserver unoconvert /path/in/container/sample.docx /tmp/out.pdf
```

Env knobs: `D362_WOPI_PORT` (8628), `D362_COLLABORA` (http://localhost:9980),
`D362_WOPI_PUBLIC_BASE` (http://host.docker.internal:8628), `D362_ACCESS_TOKEN`.

## What the operator decides (the gate — tasks 0.5.x)

1. Did `.docx` **and** `.xlsx` render + accept an edit that round-tripped? (0.2)
2. Could a custom React control drive a UNO command via JSDialog? (0.3.2)
3. **JSDialog-vs-fork**: is a fully custom chrome achievable by rendering JSDialog
   JSON, or does it need forking Collabora's `browser/` client? (0.3.3 → 0.5.2)
4. unoserver warm convert works + rough latency vs cold soffice? (0.4)
5. Write the go/no-go + measured Tier-1/Tier-2 effort + Sept-vs-post-Sept. (0.5)

## Scope / disclaimer

Spike-grade only. SSL is off; the WOPI stub accepts any token and has no auth,
no locks-with-teeth, no autosave debounce. The production paths (self-built
`coolwsd`, quarantined `/wopi/*` on `userSaveWorkspaceArtifact`, autosave
debounce, fonts, unoserver pool) are Phases 1–5 per the issue — do not harden
this harness, replace it.
