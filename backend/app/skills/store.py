"""Atomic persistent state for user-managed skill package versions."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from collections.abc import Iterable, Mapping
from pathlib import Path
from threading import RLock
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.skills.catalog import SkillCatalog, SkillDescriptor, SkillManifest
from app.skills.packages import PackageValidationError, SkillPackageLoader


class StoredVersion(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    version_id: str
    version: str
    kind: Literal["manifest", "zip"]
    relative_path: str


class StoredPackage(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str
    current: str
    enabled: bool = True
    versions: tuple[StoredVersion, ...]


class StoreState(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal[1] = 1
    packages: dict[str, StoredPackage] = Field(default_factory=dict)


class SkillDetail(BaseModel):
    model_config = ConfigDict(frozen=True)

    manifest: SkillManifest
    current_version: str
    versions: tuple[str, ...]
    package_kind: Literal["manifest", "zip"]
    warning: str | None = None


class StoreMutation(BaseModel):
    model_config = ConfigDict(frozen=True)

    generation: int
    skill: SkillManifest | None = None


class UserSkillStore:
    """Persist user package history and atomically publish catalog snapshots."""

    def __init__(
        self,
        root: Path,
        *,
        catalog: SkillCatalog,
        builtins: Iterable[SkillDescriptor] = (),
        secrets: Mapping[str, str] | None = None,
    ) -> None:
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._state_path = self.root / "state.json"
        self._lock = RLock()
        self._catalog = catalog
        self._builtins = tuple(builtins)
        self._builtin_names = {item.name for item in self._builtins}
        if len(self._builtin_names) != len(self._builtins):
            raise ValueError("builtin skill names must be unique")
        self._loader = SkillPackageLoader(secrets=secrets)
        self._loaded: dict[tuple[str, str], SkillDescriptor] = {}
        self._state = self._read_state()
        descriptors = self._load_all(self._state)
        self._publish(descriptors)

    @property
    def generation(self) -> int:
        return self._catalog.snapshot().generation

    def list_manifests(self) -> tuple[SkillManifest, ...]:
        return tuple(
            descriptor.manifest
            for descriptor in sorted(
                self._catalog.snapshot().skills.values(), key=lambda item: item.name
            )
        )

    def detail(self, name: str) -> SkillDetail:
        descriptor = self._catalog.snapshot().skills.get(name)
        if descriptor is None:
            raise KeyError(name)
        package = self._state.packages.get(name)
        if package is None:
            return SkillDetail(
                manifest=descriptor.manifest,
                current_version=descriptor.version,
                versions=(descriptor.version,),
                package_kind="manifest",
            )
        current = self._version(package, package.current)
        return SkillDetail(
            manifest=descriptor.manifest,
            current_version=current.version,
            versions=tuple(item.version for item in package.versions),
            package_kind=current.kind,
            warning=(
                "This package executes local Python code with the backend process permissions; "
                "install only code you trust."
                if current.kind == "zip"
                else None
            ),
        )

    def put_manifest(self, raw: Mapping[str, object]) -> StoreMutation:
        descriptor = self._loader.load_manifest(raw)
        content = json.dumps(dict(raw), sort_keys=True, separators=(",", ":")).encode()
        return self._put(descriptor, content, kind="manifest")

    def put_zip(self, content: bytes) -> StoreMutation:
        loaded = self._loader.load_zip(content, extraction_root=self.root / ".load")
        return self._put(loaded.descriptor, content, kind="zip")

    def validate_manifest(self, raw: Mapping[str, object]) -> SkillDescriptor:
        return self._loader.load_manifest(raw)

    def validate_zip(self, content: bytes) -> SkillDescriptor:
        return self._loader.load_zip(
            content, extraction_root=self.root / ".validate"
        ).descriptor

    def set_enabled(self, name: str, *, enabled: bool) -> StoreMutation:
        with self._lock:
            package = self._require_user(name)
            state = self._replace_package(
                package.model_copy(update={"enabled": enabled})
            )
            descriptors = self._load_all(state)
            self._commit_state(state)
            snapshot = self._publish(descriptors)
            return StoreMutation(
                generation=snapshot.generation,
                skill=snapshot.skills[name].manifest,
            )

    def rollback(self, name: str) -> StoreMutation:
        with self._lock:
            package = self._require_user(name)
            index = next(
                idx for idx, item in enumerate(package.versions)
                if item.version_id == package.current
            )
            if index == 0:
                raise ValueError("no previous version is available")
            updated = package.model_copy(
                update={"current": package.versions[index - 1].version_id}
            )
            state = self._replace_package(updated)
            descriptors = self._load_all(state)
            self._commit_state(state)
            snapshot = self._publish(descriptors)
            return StoreMutation(
                generation=snapshot.generation,
                skill=snapshot.skills[name].manifest,
            )

    def delete(self, name: str) -> StoreMutation:
        with self._lock:
            if name in self._builtin_names:
                raise PermissionError("builtin skills are immutable")
            self._require_user(name)
            packages = dict(self._state.packages)
            del packages[name]
            state = self._state.model_copy(update={"packages": packages})
            descriptors = self._load_all(state)
            self._commit_state(state)
            snapshot = self._publish(descriptors)
            shutil.rmtree(self.root / "packages" / name, ignore_errors=True)
            for key in [key for key in self._loaded if key[0] == name]:
                del self._loaded[key]
            return StoreMutation(generation=snapshot.generation)

    def _put(
        self,
        descriptor: SkillDescriptor,
        content: bytes,
        *,
        kind: Literal["manifest", "zip"],
    ) -> StoreMutation:
        with self._lock:
            if descriptor.name in self._builtin_names:
                raise PackageValidationError(
                    f"skill name conflicts with builtin: {descriptor.name}"
                )
            version_id = hashlib.sha256(content).hexdigest()
            existing = self._state.packages.get(descriptor.name)
            if existing is not None and any(
                item.version_id == version_id for item in existing.versions
            ):
                raise FileExistsError("identical package version is already stored")
            relative = f"packages/{descriptor.name}/{version_id}.{kind}"
            version = StoredVersion(
                version_id=version_id,
                version=descriptor.version,
                kind=kind,
                relative_path=relative,
            )
            enabled = descriptor.enabled if existing is None else existing.enabled
            versions = (version,) if existing is None else (*existing.versions, version)
            package = StoredPackage(
                name=descriptor.name,
                current=version_id,
                enabled=enabled,
                versions=versions,
            )
            state = self._replace_package(package)
            candidate = descriptor.model_copy(update={"enabled": enabled})
            self._loaded[(descriptor.name, version_id)] = candidate
            try:
                descriptors = self._load_all(state)
                self._atomic_write(self.root / relative, content)
                self._commit_state(state)
                snapshot = self._publish(descriptors)
            except Exception:
                self._loaded.pop((descriptor.name, version_id), None)
                raise
            return StoreMutation(
                generation=snapshot.generation,
                skill=snapshot.skills[descriptor.name].manifest,
            )

    def _replace_package(self, package: StoredPackage) -> StoreState:
        packages = dict(self._state.packages)
        packages[package.name] = package
        return self._state.model_copy(update={"packages": packages})

    def _load_all(self, state: StoreState) -> tuple[SkillDescriptor, ...]:
        descriptors = list(self._builtins)
        names = set(self._builtin_names)
        for name in sorted(state.packages):
            if name in names:
                raise PackageValidationError(f"skill name conflicts with builtin: {name}")
            package = state.packages[name]
            version = self._version(package, package.current)
            descriptor = self._loaded.get((name, version.version_id))
            if descriptor is None:
                path = self.root / version.relative_path
                content = path.read_bytes()
                if version.kind == "manifest":
                    raw = json.loads(content.decode("utf-8"))
                    descriptor = self._loader.load_manifest(raw)
                else:
                    descriptor = self._loader.load_zip(
                        content, extraction_root=self.root / ".load"
                    ).descriptor
                self._loaded[(name, version.version_id)] = descriptor
            descriptor = descriptor.model_copy(update={"enabled": package.enabled})
            descriptors.append(descriptor)
            names.add(name)
        return tuple(descriptors)

    def _read_state(self) -> StoreState:
        if not self._state_path.exists():
            return StoreState()
        try:
            return StoreState.model_validate_json(self._state_path.read_text("utf-8"))
        except ValueError as error:
            raise PackageValidationError("stored skill state is invalid") from error

    def _commit_state(self, state: StoreState) -> None:
        self._atomic_write(
            self._state_path,
            state.model_dump_json(indent=2).encode("utf-8"),
        )
        self._state = state

    def _publish(self, descriptors: tuple[SkillDescriptor, ...]):
        return self._catalog.replace_all(descriptors)

    def _require_user(self, name: str) -> StoredPackage:
        if name in self._builtin_names:
            raise PermissionError("builtin skills are immutable")
        package = self._state.packages.get(name)
        if package is None:
            raise KeyError(name)
        return package

    @staticmethod
    def _version(package: StoredPackage, version_id: str) -> StoredVersion:
        return next(item for item in package.versions if item.version_id == version_id)

    @staticmethod
    def _atomic_write(path: Path, content: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_name, path)
        except Exception:
            Path(temp_name).unlink(missing_ok=True)
            raise
