"""Isolated SourceAsset staging for one managed subagent."""

from __future__ import annotations

import hashlib
import os
import re
import stat
import tempfile
import threading
from contextlib import AbstractContextManager
from pathlib import Path, PurePosixPath
from types import TracebackType

from app.domain.contracts import DataLevel, SourceAsset, asset_id_from_sha256

_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_SAFE_MEDIA_TYPE = re.compile(r"^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$")
_WORKSPACE_LOCKS: dict[str, threading.RLock] = {}
_WORKSPACE_LOCKS_GUARD = threading.Lock()


class _MovedFileRollbackGuard(AbstractContextManager["_MovedFileRollbackGuard"]):
    """Keep an OS handle that can delete the exact file object after a move."""

    def __init__(
        self,
        source: Path,
        destination: Path,
        *,
        source_identity: tuple[int, int],
        parent_identity: tuple[int, int],
    ) -> None:
        self._destination_name = destination.name
        self._source_identity = source_identity
        self._parent_fd: int | None = None
        self._windows_handle: int | None = None
        if os.name == "nt":
            self._windows_handle = _open_windows_delete_handle(source)
        else:
            flags = os.O_RDONLY
            flags |= getattr(os, "O_DIRECTORY", 0)
            flags |= getattr(os, "O_NOFOLLOW", 0)
            self._parent_fd = os.open(destination.parent, flags)
            if _file_identity(os.fstat(self._parent_fd)) != parent_identity:
                self.close()
                raise ValueError("destination parent changed before SourceAsset move")

    def rollback(self) -> None:
        """Delete the moved file by its retained object/directory handle."""

        if self._windows_handle is not None:
            _mark_windows_handle_for_deletion(self._windows_handle)
            return
        assert self._parent_fd is not None
        try:
            path_stat = os.stat(
                self._destination_name,
                dir_fd=self._parent_fd,
                follow_symlinks=False,
            )
        except OSError:
            return
        if (
            not _is_link_or_reparse_stat(path_stat)
            and _file_identity(path_stat) == self._source_identity
            and stat.S_ISREG(path_stat.st_mode)
        ):
            os.unlink(self._destination_name, dir_fd=self._parent_fd)

    def close(self) -> None:
        if self._windows_handle is not None:
            _close_windows_handle(self._windows_handle)
            self._windows_handle = None
        if self._parent_fd is not None:
            os.close(self._parent_fd)
            self._parent_fd = None

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()


class SubagentStagingWorkspace:
    """Own the only writable tree exposed to one child research agent."""

    def __init__(self, task_root: str | Path, subagent_id: str) -> None:
        if not _SAFE_ID.fullmatch(subagent_id):
            raise ValueError("subagent_id must be a safe path identifier")
        task_path = Path(task_root).absolute()
        self._lock = _workspace_lock(task_path)
        with self._lock:
            if task_path.exists() or task_path.is_symlink():
                _reject_link_or_reparse(task_path)
            task_path.mkdir(parents=True, exist_ok=True)
            resolved_task = task_path.resolve(strict=True)
            if not _same_path(task_path, resolved_task):
                raise ValueError("task root must be a trusted non-link directory")
            _reject_link_or_reparse(resolved_task)
            self.task_root = resolved_task
            self.source_assets_root = self.task_root / "source_assets"
            self.root = self.task_root / "staging" / "subagents" / subagent_id
            self._create_trusted_directory(self.root)
            self._assert_workspace_roots()

    def validate_path(self, path: str | Path, *, require_file: bool = True) -> Path:
        """Resolve and validate a path without accepting links or escapes."""

        with self._lock:
            self._assert_workspace_roots()
            candidate = Path(path)
            if not candidate.is_absolute():
                candidate = self.root / candidate
            candidate = candidate.absolute()
            self._assert_trusted_path(candidate, boundary=self.root)
            try:
                resolved = candidate.resolve(strict=require_file)
            except (OSError, RuntimeError) as error:
                raise ValueError("path must remain inside the staging workspace") from error
            if not resolved.is_relative_to(self.root):
                raise ValueError("path must remain inside the staging workspace")
            self._assert_trusted_path(candidate, boundary=self.root)
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

        with self._lock:
            self._assert_workspace_roots()
            if not content:
                raise ValueError("source asset content must not be empty")
            self._validate_filename(filename)
            self._validate_media_type(media_type)
            checksum = hashlib.sha256(content).hexdigest()
            asset_id = asset_id_from_sha256(checksum)
            relative_path = PurePosixPath("source_assets", asset_id, filename).as_posix()
            destination = self.root / relative_path
            self._create_trusted_directory(destination.parent)
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
                self._replace_checked(
                    temporary,
                    destination,
                    boundary=self.root,
                )
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

        with self._lock:
            self._assert_workspace_roots()
            staged = self.validate_source_asset(asset)
            relative = self._validate_asset_relative_path(asset)
            destination = self.task_root / relative
            if not destination.is_relative_to(self.source_assets_root):
                raise ValueError("SourceAsset destination must remain inside source_assets")
            self._create_trusted_directory(self.source_assets_root)
            self._create_trusted_directory(destination.parent)
            if staged.stat().st_dev != destination.parent.stat().st_dev:
                raise ValueError("SourceAsset commit requires the same filesystem")
            if destination.exists() or destination.is_symlink():
                self._assert_trusted_path(
                    destination,
                    boundary=self.source_assets_root,
                )
                destination_stat = destination.lstat()
                if (
                    _is_link_or_reparse_stat(destination_stat)
                    or not destination.is_file()
                    or destination_stat.st_nlink != 1
                    or destination_stat.st_size != asset.size_bytes
                    or self._sha256_file(destination) != asset.sha256
                ):
                    raise ValueError("existing SourceAsset destination does not match")
                staged.unlink()
                return asset
            self._replace_checked(
                staged,
                destination,
                boundary=self.source_assets_root,
            )
            destination_stat = destination.lstat()
            if (
                _is_link_or_reparse_stat(destination_stat)
                or destination_stat.st_nlink != 1
                or destination_stat.st_size != asset.size_bytes
                or self._sha256_file(destination) != asset.sha256
            ):
                self._unlink_if_identity(
                    destination,
                    _file_identity(destination_stat),
                )
                raise ValueError("committed SourceAsset failed validation")
            self._assert_workspace_roots()
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

    def _assert_trusted_path(self, path: Path, *, boundary: Path) -> None:
        current = path.absolute()
        limit = boundary.absolute()
        if not current.is_relative_to(limit):
            raise ValueError("path must remain inside the staging workspace")
        while True:
            if current.exists() or current.is_symlink():
                _reject_link_or_reparse(current)
            if current == limit:
                break
            current = current.parent
        resolved = path.resolve(strict=False)
        if not resolved.is_relative_to(limit):
            raise ValueError("path must remain inside the staging workspace")

    def _assert_workspace_roots(self) -> None:
        self._assert_trusted_path(self.task_root, boundary=self.task_root)
        self._assert_trusted_path(self.root, boundary=self.task_root)
        if not self.root.is_dir():
            raise ValueError("staging workspace must be a trusted directory")

    def _create_trusted_directory(self, path: Path) -> None:
        if not path.absolute().is_relative_to(self.task_root):
            raise ValueError("directory must remain inside the trusted task root")
        missing: list[Path] = []
        current = path.absolute()
        while not current.exists() and not current.is_symlink():
            missing.append(current)
            current = current.parent
        self._assert_trusted_path(current, boundary=self.task_root)
        for directory in reversed(missing):
            directory.mkdir()
            _reject_link_or_reparse(directory)
        self._assert_trusted_path(path, boundary=self.task_root)

    def _replace_checked(
        self,
        source: Path,
        destination: Path,
        *,
        boundary: Path,
    ) -> None:
        self._assert_trusted_path(source, boundary=self.root)
        self._assert_trusted_path(destination.parent, boundary=boundary)
        source_stat = source.lstat()
        if _is_link_or_reparse_stat(source_stat) or source_stat.st_nlink != 1:
            raise ValueError("SourceAsset move source must be an unlinked file")
        source_identity = _file_identity(source_stat)
        parent_identity = _file_identity(destination.parent.lstat())
        moved = False
        with _MovedFileRollbackGuard(
            source,
            destination,
            source_identity=source_identity,
            parent_identity=parent_identity,
        ) as rollback_guard:
            try:
                source.replace(destination)
                moved = True
                self._validate_replaced_destination(
                    destination,
                    boundary=boundary,
                    parent_identity=parent_identity,
                    source_identity=source_identity,
                )
            except BaseException:
                if moved:
                    rollback_guard.rollback()
                raise

    def _validate_replaced_destination(
        self,
        destination: Path,
        *,
        boundary: Path,
        parent_identity: tuple[int, int],
        source_identity: tuple[int, int],
    ) -> None:
        self._assert_trusted_path(destination.parent, boundary=boundary)
        if _file_identity(destination.parent.lstat()) != parent_identity:
            raise ValueError("destination parent changed during SourceAsset commit")
        destination_stat = destination.lstat()
        if (
            _is_link_or_reparse_stat(destination_stat)
            or destination_stat.st_nlink != 1
            or _file_identity(destination_stat) != source_identity
        ):
            raise ValueError("destination changed during SourceAsset commit")
        self._assert_trusted_path(destination, boundary=boundary)

    @staticmethod
    def _unlink_if_identity(path: Path, identity: tuple[int, int]) -> None:
        try:
            path_stat = path.lstat()
        except OSError:
            return
        if (
            not _is_link_or_reparse_stat(path_stat)
            and _file_identity(path_stat) == identity
            and stat.S_ISREG(path_stat.st_mode)
        ):
            path.unlink(missing_ok=True)

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


def _workspace_lock(task_root: Path) -> threading.RLock:
    key = os.path.normcase(os.path.normpath(str(task_root)))
    with _WORKSPACE_LOCKS_GUARD:
        return _WORKSPACE_LOCKS.setdefault(key, threading.RLock())


def _same_path(left: Path, right: Path) -> bool:
    return os.path.normcase(os.path.normpath(str(left))) == os.path.normcase(
        os.path.normpath(str(right))
    )


def _file_identity(path_stat: os.stat_result) -> tuple[int, int]:
    return path_stat.st_dev, path_stat.st_ino


def _is_link_or_reparse_stat(path_stat: os.stat_result) -> bool:
    file_attributes = getattr(path_stat, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return stat.S_ISLNK(path_stat.st_mode) or bool(file_attributes & reparse_flag)


def _reject_link_or_reparse(path: Path) -> None:
    try:
        path_stat = path.lstat()
    except OSError as error:
        raise ValueError("trusted path could not be inspected") from error
    if _is_link_or_reparse_stat(path_stat):
        raise ValueError("symlink or reparse point is forbidden in trusted staging workspace paths")


def _open_windows_delete_handle(path: Path) -> int:
    if os.name != "nt":  # pragma: no cover - guarded by the caller
        raise OSError("Windows file handles are unavailable on this platform")
    import ctypes
    from ctypes import wintypes

    create_file = ctypes.windll.kernel32.CreateFileW
    create_file.argtypes = (
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    )
    create_file.restype = wintypes.HANDLE
    delete_access = 0x00010000
    generic_read = 0x80000000
    share_read_write_delete = 0x00000001 | 0x00000002 | 0x00000004
    open_existing = 3
    file_attribute_normal = 0x00000080
    file_flag_open_reparse_point = 0x00200000
    handle = create_file(
        str(path),
        generic_read | delete_access,
        share_read_write_delete,
        None,
        open_existing,
        file_attribute_normal | file_flag_open_reparse_point,
        None,
    )
    if handle == wintypes.HANDLE(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    return int(handle)


def _mark_windows_handle_for_deletion(handle: int) -> None:
    if os.name != "nt":  # pragma: no cover - guarded by the caller
        raise OSError("Windows file handles are unavailable on this platform")
    import ctypes
    from ctypes import wintypes

    class FileDispositionInfo(ctypes.Structure):
        _fields_ = [("delete_file", wintypes.BOOL)]

    set_file_information = ctypes.windll.kernel32.SetFileInformationByHandle
    set_file_information.argtypes = (
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.LPVOID,
        wintypes.DWORD,
    )
    set_file_information.restype = wintypes.BOOL
    disposition = FileDispositionInfo(True)
    if not set_file_information(
        wintypes.HANDLE(handle),
        4,
        ctypes.byref(disposition),
        ctypes.sizeof(disposition),
    ):
        raise ctypes.WinError(ctypes.get_last_error())


def _close_windows_handle(handle: int) -> None:
    if os.name != "nt":  # pragma: no cover - guarded by the caller
        return
    import ctypes
    from ctypes import wintypes

    close_handle = ctypes.windll.kernel32.CloseHandle
    close_handle.argtypes = (wintypes.HANDLE,)
    close_handle.restype = wintypes.BOOL
    close_handle(wintypes.HANDLE(handle))
