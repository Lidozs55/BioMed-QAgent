"""Static Phase 1G contracts that remain runnable without a Node installation."""

from __future__ import annotations

import json
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).parents[2]


def test_root_development_scripts_make_the_typescript_host_the_default() -> None:
    package = json.loads((REPOSITORY_ROOT / "package.json").read_text(encoding="utf-8"))

    assert package["scripts"]["dev"] == "pnpm --filter @biomed/server dev"
    assert package["scripts"]["dev:frontend-standalone"] == (
        "pnpm --filter @biomed/frontend dev"
    )
    assert package["scripts"]["dev:legacy-backend"] == (
        "node scripts/dev-profile.mjs legacy-backend"
    )
    assert package["scripts"]["dev:host-proxy-only"] == (
        "node scripts/dev-profile.mjs host-proxy-only"
    )
    assert package["scripts"]["dev:legacy-rollback"] == (
        "node scripts/dev-profile.mjs legacy-rollback"
    )


def test_default_host_profile_exposes_only_the_explicit_pi_surface() -> None:
    config = (REPOSITORY_ROOT / "server" / "src" / "config.ts").read_text(
        encoding="utf-8"
    )

    assert 'APP_HOST: "ts"' in config
    assert 'AGENT_RUNTIME: "legacy"' in config
    assert 'DATASET_CORE: "python"' in config
    assert 'PI_EXPERIMENTAL: "1"' in config


def test_cross_platform_debug_profile_launcher_is_present() -> None:
    launcher = REPOSITORY_ROOT / "scripts" / "dev-profile.mjs"

    assert launcher.is_file()
    source = launcher.read_text(encoding="utf-8")
    assert '"legacy-backend"' in source
    assert '"host-proxy-only"' in source
    assert '"legacy-rollback"' in source
    assert "process.platform" in source


def test_typescript_host_reads_the_documented_root_environment_file() -> None:
    package = json.loads(
        (REPOSITORY_ROOT / "server" / "package.json").read_text(encoding="utf-8")
    )

    assert package["scripts"]["dev"] == (
        "tsc -p tsconfig.json && "
        "node --env-file-if-exists=../.env dist/index.js"
    )
