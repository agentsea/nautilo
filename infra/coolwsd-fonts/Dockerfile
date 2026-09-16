# D362 §2.1.4 — font layer for the Collabora coolwsd engine.
#
# Thin derived image that installs MS-metric-compatible + broad-Unicode
# fonts on top of the pinned coolwsd base, then refreshes fontconfig.
# Idempotent: `apt-get install` is a no-op for already-present packages,
# so this is safe to layer on whatever the base image already ships
# (the official collabora/code image already bundles Liberation / Carlito
# / Caladea / DejaVu — this guarantees they are present and adds Noto for
# broad Unicode coverage). The operator does not need to pre-confirm
# which fonts are missing; the layer is cheap either way.
#
# Dev base:  collabora/code:<DEPENDENCY_PINS.collabora>  (official CODE image)
# Prod base: future self-built coolwsd image (Phase 5.2 — not yet built).
#   When that lands, EITHER flip COOLWSD_BASE here to the self-built
#   image tag, OR fold this RUN stanza into the Phase-5.2 Dockerfile
#   verbatim — the package list + `fc-cache` are the same. Keeping the
#   stanza isolated and idempotent makes both paths cheap; folding it
#   into the self-build Dockerfile avoids a double layer in prod.
#
# Build context: `infra/coolwsd-fonts/` (this directory). No source
# files are needed — the Dockerfile is the entire context, so there is
# no .dockerignore to maintain.

# MUST mirror DEPENDENCY_PINS.collabora in deploy/dependency-pins.ts.
# That pin is the sync source for the coolwsd base tag.
ARG COOLWSD_BASE=collabora/code:26.04.1.4.1
FROM ${COOLWSD_BASE}

# The collabora/code base drops to a NON-ROOT runtime user (UID 1001), so a
# bare `apt-get update` in the layer below fails with exit 100 (can't write
# /var/lib/apt). Switch to root for the install, then restore UID 1001 at the
# end so coolwsd still starts unprivileged (identical runtime to the base).
USER root

# fonts-liberation / fonts-liberation2 — Arial / Times New Roman / Courier
#   New metric-compatible substitutes (Liberation is the classic one).
# fonts-crosextra-carlito — Calibri metric-compatible (Carlito).
# fonts-crosextra-caladea — Cambria metric-compatible (Caladea).
# fonts-dejavu / fonts-dejavu-extra — broad Latin / Cyrillic / Greek.
# fonts-noto-core / fonts-noto-cjk / fonts-noto-color-emoji — broad
#   Unicode (CJK + emoji) for non-Latin doc content.
#
# `fc-cache -f` rebuilds fontconfig's cache so the next coolwsd / soffice
# process picks up the new fonts without a manual cache step at runtime.
# `rm -rf /var/lib/apt/lists/*` keeps the layer small and avoids stale
# apt index drift on rebuild.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fonts-liberation \
      fonts-liberation2 \
      fonts-crosextra-carlito \
      fonts-crosextra-caladea \
      fonts-dejavu \
      fonts-dejavu-extra \
      fonts-noto-core \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f

# Restore the base image's unprivileged runtime user so coolwsd does not run
# as root (matches the collabora/code default; see USER root note above).
USER 1001
