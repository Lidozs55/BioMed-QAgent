"""Isolated SourceAsset staging for one managed subagent."""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
from pathlib import Path, PurePosixPath

from app.domain.contracts import DataLevel, SourceAsset, asset_id_from_sha256

_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_SAFE_MEDIA_TYPE = re.compile(r"^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$")


class SubagentStagingWorkspace:
    """Own the only writable tree exposed to one child research agent."""

    def __init__(self, task_root: str | Path, subagent_id: str) -> None:
        if not _SAFE_ID.fullmatch(subagent_id):
            raise ValueError("subagent_id must be a safe path identifier")
        task_path = Path(task_root)
        task_path.mkdir(parents=True, exist_ok=True)
        self.task_root = task_path.resolve()
        self.source_assets_root = self.task_root / "source_assets"
        self.root = self.task_root / "staging" / "subagents" / subagent_id
        self.root.mkdir(parents=True, exist_ok=True)
        self.root = self.root.resolve()

    def validate_path(self, path: str | Path, *, require_file: bool = True) -> Path:
        """Resolve and validate a path without accepting links or escapes."""

        candidate = Path(path)
        if not candidate.is_absolute():
            candidate = self.root / candidate
        try:
            resolved = candidate.resolve(strict=require_file)
        except (OSError, RuntimeError) as error:
            raise ValueError("path must remain inside the staging workspace") from error
        if not resolved.is_relative_to(self.root):
            raise ValueError("path must remain inside the staging workspace")
        self._reject_symlink_components(candidate, boundary=self.root)
        if require_file and not resolved.is_file():
            raise ValueError("staging workspace path must be an existing file")
        return resolved

    def stage_bytes(
        self,
        *,
        content: bytes,
        filename: str,
        source_id: str,
        successful_attempt_id: str,
        data_level: DataLevel,
        media_type: str,
    ) -> SourceAsset:
        """Write candidate bytes atomically and return their future task path."""

        if not content:
            raise ValueError("source asset content must not be empty")
        self._validate_filename(filename)
        self._validate_media_type(media_type)
        checksum = hashlib.sha256(content).hexdigest()
        asset_id = asset_id_from_sha256(checksum)
        relative_path = PurePosixPath("source_assets", asset_id, filename).as_posix()
        destination = self.root / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="xb",
                dir=destination.parent,
                prefix=f".{filename}.",
                suffix=".tmp",
                delete=False,
            ) as handle:
                temporary = Path(handle.name)
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            temporary.replace(destination)
            temporary = None
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return SourceAsset(
            asset_id=asset_id,
            relative_path=relative_path,
            sha256=checksum,
            size_bytes=len(content),
            media_type=media_type,
            source_id=source_id,
            successful_attempt_id=successful_attempt_id,
            data_level=data_level,
        )

    def staged_path(self, asset: SourceAsset) -> Path:
        """Return and validate the physical candidate path for an asset."""

        relative = self._validate_asset_relative_path(asset)
        return self.validate_path(self.root / relative)

    def validate_source_asset(self, asset: SourceAsset) -> Path:
        """Validate content and metadata before the parent task can consume it."""

        path = self.staged_path(asset)
        stat = path.stat()
        if stat.st_nlink != 1:
            raise ValueError("staged source asset must not be a hardlink")
        if stat.st_size <= 0 or stat.st_size != asset.size_bytes:
            raise ValueError("source asset size does not match staged file")
        if self._sha256_file(path) != asset.sha256:
            raise ValueError("source asset checksum does not match staged file")
        self._validate_media_type(asset.media_type)
        if not asset.source_id.strip() or not asset.successful_attempt_id.strip():
            raise ValueError("source asset source and attempt metadata are required")
        return path

    def commit_source_asset(self, asset: SourceAsset) -> SourceAsset:
        """Atomically move a validated candidate into task ``source_assets``."""

        staged = self.validate_source_asset(asset)
        relative = self._validate_asset_relative_path(asset)
        destination = self.task_root / relative
        if not destination.is_relative_to(self.source_assets_root):
            raise ValueError("SourceAsset destination must remain inside source_assets")
        self.source_assets_root.mkdir(parents=True, exist_ok=True)
        self._reject_symlink_components(
            self.source_assets_root,
            boundary=self.task_root,
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        self._reject_symlink_components(
            destination.parent,
            boundary=self.task_root,
        )
        if staged.stat().st_dev != destination.parent.stat().st_dev:
            raise ValueError("SourceAsset commit requires the same filesystem")
        if destination.exists():
            if (
                destination.is_symlink()
                or not destination.is_file()
                or destination.stat().st_size != asset.size_bytes
                or self._sha256_file(destination) != asset.sha256
            ):
                raise ValueError("existing SourceAsset destination does not match")
            staged.unlink()
            return asset
        moved = False
        try:
            staged.replace(destination)
            moved = True
            if (
                destination.stat().st_size != asset.size_bytes
                or self._sha256_file(destination) != asset.sha256
            ):
                raise ValueError("committed SourceAsset failed validation")
        except BaseException:
            if moved:
                destination.unlink(missing_ok=True)
            raise
        return asset

    def _validate_asset_relative_path(self, asset: SourceAsset) -> Path:
        relative = PurePosixPath(asset.relative_path)
        if (
            len(relative.parts) < 3
            or relative.parts[0] != "source_assets"
            or relative.parts[1] != asset.asset_id
        ):
            raise ValueError("SourceAsset path does not match its checksum-derived asset identity")
        return Path(*relative.parts)

    @staticmethod
    def _reject_symlink_components(path: Path, *, boundary: Path) -> None:
        current = path.absolute()
        limit = boundary.absolute()
        if not current.is_relative_to(limit):
            raise ValueError("path must remain inside the staging workspace")
        while True:
            if current.is_symlink():
                raise ValueError("symlinks are forbidden in the staging workspace")
            if current == limit:
                break
            current = current.parent

    @staticmethod
    def _validate_filename(filename: str) -> None:
        if (
            not filename
            or Path(filename).name != filename
            or filename in {".", ".."}
            or "\\" in filename
        ):
            raise ValueError("source asset filename is unsafe")

    @staticmethod
    def _validate_media_type(media_type: str) -> None:
        normalized = media_type.split(";", 1)[0].strip()
        if not _SAFE_MEDIA_TYPE.fullmatch(normalized):
            raise ValueError("source asset media type is invalid")

    @staticmethod
    def _sha256_file(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
