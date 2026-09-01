# Env removal follow-up handoff

> Branch: `fix/env-removal-handoff`  
> Base observed at handoff: `origin/main@d7b4ea82`  
> Scope owner after this handoff: not the Gold6 R3 closure work

## Context

Commit `d1cc6415` removed environment-based model bootstrap and `.env.example`.
Model providers, API keys, the active main model, and the visual model now belong
to the persistent Web Settings / model-registry path. The removal left setup
documentation and the portable packer referring to the deleted template.

## Completed on this branch

Commit `adfbf290` (`docs: align setup after env removal`) changes only:

- `README.md`
- `docs/DEVELOPER_QUICKSTART.md`
- `docs/packaging.md`
- `scripts/pack-release.mjs`

The docs now direct users to **Settings → Models** for provider/API-key/main-model/
visual-model configuration. A root `.env` is described only as an optional Host
or deployment override (`HOST`, `PORT`, `BIOMED_PYTHON_BIN`, and similar), not a
model credential source. Portable launchers no longer copy `.env.example`, the
packer no longer stages that deleted file, and generated package instructions use
the Web Settings flow.

## Verification completed

- `pnpm docs:check` — passed.
- `node --check scripts/pack-release.mjs` — passed.
- `git diff --check` — passed.
- The commit's pre-commit hook ran workspace typecheck and lint — passed.
- Linux pack attempts passed source snapshot, frozen install, frontend/server/
  contracts builds, and deploy staging without an `.env.example` error.

## Outstanding package gate

A complete Linux portable package was **not** produced. Two attempts were blocked
while downloading the pinned `python-build-standalone` CPython archive from
GitHub: the first could not connect; the second downloaded roughly 54 MiB before
the 40-minute command timeout. This is a network-throughput failure, not evidence
that the final launcher/runtime smoke tests pass.

The packer's downloader writes directly to the final cache filename and does not
resume or validate a checksum. Before retrying, remove any truncated local cache:

```bash
rm -f target/.cache/cpython-3.12.14+20260825-x86_64-unknown-linux-gnu-install_only.tar.gz
rm -rf target/.tmp-pack-linux-* target/biomed-qagent-1.0.0-linux
```

Then use a reliable GitHub route (the script documents an HTTPS proxy example):

```bash
https_proxy=http://127.0.0.1:7897 \
  pnpm run pack -- --platform=linux --ref=fix/env-removal-handoff
```

Do not mark the package gate complete until all of these hold:

```bash
PKG=target/biomed-qagent-1.0.0-linux
test -f "$PKG/start.sh"
test -f "$PKG/README.txt"
test -x "$PKG/runtime/node/bin/node"
test -x "$PKG/runtime/python/bin/python3"
test ! -e "$PKG/.env.example"
! rg -n '\.env\.example|DASHSCOPE_API_KEY|PI_API_KEY' \
  "$PKG/start.sh" "$PKG/README.txt"
"$PKG/runtime/node/bin/node" --version
"$PKG/runtime/python/bin/python3" --version
```

A useful follow-up hardening is to download into a `.part` path, rename only on
success, and verify a pinned digest so an interrupted cache cannot be mistaken for
a complete runtime archive. That hardening is intentionally not included here.

## Workflow note

Commonly check-in could not be performed in the originating Pi session because
neither `commonly_*` tools nor the `commonly` CLI were available. This branch is
pushed for handoff only and is not merged by the Gold6 R3 work.
