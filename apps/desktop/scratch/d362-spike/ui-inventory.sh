#!/usr/bin/env bash
# D362 UI inventory probe — dump Collabora's per-app UI surface (notebookbar
# tabs, DOM button labels, canvas count, per-app chrome) for the UI audit
# (specs/libreoffice-office-ui.md). Re-run to diff across Collabora versions.
#
# Prereqs: collabora/code on :9980, and a WOPI stub on :8628 serving ids
# spike-docx / spike-xlsx / spike-pptx (see the audit stub in that spec's
# grounding notes). Uses agent-browser with a fresh session.
set -uo pipefail

COOL="${COOL_URL:-http://localhost:9980}"
WOPI="${WOPI_BASE:-http://host.docker.internal:8628}"
export AGENT_BROWSER_SESSION="${AGENT_BROWSER_SESSION:-d362audit}"

HASH=$(curl -s "$COOL/hosting/discovery" | grep -oE 'browser/[a-f0-9]+/cool.html' | head -1 | cut -d/ -f2)
[ -z "$HASH" ] && { echo "collabora discovery not reachable at $COOL"; exit 1; }

INV='JSON.stringify({title:document.title,canvases:document.querySelectorAll("canvas").length,buttons:document.querySelectorAll("button").length,jsdialogNodes:document.querySelectorAll(".jsdialog,[id^=NOTEBOOKBAR]").length,tabs:[...new Set([...document.querySelectorAll("[role=tab],.ui-tab")].map(e=>e.textContent.trim()).filter(Boolean))].slice(0,20),sidebar:!!document.querySelector("#sidebar-dock-wrapper,.sidebar,#sidebar-panel"),formulabar:!!document.querySelector("#formulabar,.inputbar_container,#sc_input_window"),sheettabs:!!document.querySelector("#spreadsheet-tab-scroll,.spreadsheet-tab,#tabs-container"),labels:[...new Set([...document.querySelectorAll("button[aria-label]")].map(b=>b.getAttribute("aria-label")).filter(Boolean))]})'

for pair in "docx:Writer" "xlsx:Calc" "pptx:Impress"; do
  id="spike-${pair%%:*}"; app="${pair##*:}"
  src=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote('$WOPI/wopi/files/$id',safe=''))")
  url="$COOL/browser/$HASH/cool.html?WOPISrc=$src&access_token=t&permission=edit"
  agent-browser open "$url" >/dev/null 2>&1
  agent-browser wait --load networkidle >/dev/null 2>&1
  sleep 13
  echo "===== $app ($id) ====="
  agent-browser eval "$INV" 2>/dev/null | tail -1 | tee "/tmp/inv-$app.json"
done
