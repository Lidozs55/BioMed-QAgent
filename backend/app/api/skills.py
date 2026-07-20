"""Management API for the lifespan-owned dynamic skill catalog."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from pydantic import BaseModel, ConfigDict

from app.skills.catalog import SkillManifest
from app.skills.packages import PackageValidationError, parse_manifest_document
from app.skills.store import SkillDetail, StoreMutation, UserSkillStore

router = APIRouter(prefix="/api/v1/skills", tags=["skills"])


def get_skill_store(request: Request) -> UserSkillStore:
    store = getattr(request.app.state, "skill_store", None)
    if store is None:
        raise HTTPException(status_code=503, detail="Skill catalog is unavailable")
    return store


SkillStoreDep = Annotated[UserSkillStore, Depends(get_skill_store)]


class SkillListResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    generation: int
    skills: tuple[SkillManifest, ...]


class ValidationResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    valid: bool = True
    skill: SkillManifest
    warning: str | None = None


@router.get("", response_model=SkillListResponse)
async def list_skills(store: SkillStoreDep) -> SkillListResponse:
    return SkillListResponse(generation=store.generation, skills=store.list_manifests())


@router.get("/{name}", response_model=SkillDetail)
async def get_skill(name: str, store: SkillStoreDep) -> SkillDetail:
    try:
        return store.detail(name)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Skill not found") from error


@router.post("/{name}/enable", response_model=StoreMutation)
async def enable_skill(name: str, store: SkillStoreDep) -> StoreMutation:
    return _set_enabled(store, name, enabled=True)


@router.post("/{name}/disable", response_model=StoreMutation)
async def disable_skill(name: str, store: SkillStoreDep) -> StoreMutation:
    return _set_enabled(store, name, enabled=False)


@router.post("/{name}/rollback", response_model=StoreMutation)
async def rollback_skill(name: str, store: SkillStoreDep) -> StoreMutation:
    try:
        return store.rollback(name)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Skill not found") from error
    except PermissionError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.delete("/{name}", response_model=StoreMutation)
async def delete_skill(name: str, store: SkillStoreDep) -> StoreMutation:
    try:
        return store.delete(name)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Skill not found") from error
    except PermissionError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.post("/validate", response_model=ValidationResponse)
async def validate_skill(
    file: Annotated[UploadFile, File()], store: SkillStoreDep
) -> ValidationResponse:
    content = await file.read()
    try:
        if (file.filename or "").lower().endswith(".zip"):
            descriptor = store.validate_zip(content)
            warning = (
                "This package executes local Python code with the backend process permissions; "
                "install only code you trust."
            )
        else:
            descriptor = store.validate_manifest(
                parse_manifest_document(content, file.filename or "manifest.json")
            )
            warning = None
        return ValidationResponse(skill=descriptor.manifest, warning=warning)
    except (PackageValidationError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    finally:
        await file.close()


@router.post("/upload", response_model=StoreMutation)
async def upload_skill(
    file: Annotated[UploadFile, File()], store: SkillStoreDep
) -> StoreMutation:
    content = await file.read()
    try:
        if (file.filename or "").lower().endswith(".zip"):
            return store.put_zip(content)
        return store.put_manifest(
            parse_manifest_document(content, file.filename or "manifest.json")
        )
    except (PackageValidationError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except FileExistsError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    finally:
        await file.close()


@router.put("/{name}/manifest", response_model=StoreMutation)
async def put_skill_manifest(
    name: str, body: dict[str, Any], store: SkillStoreDep
) -> StoreMutation:
    if body.get("name") != name:
        raise HTTPException(status_code=409, detail="Path and manifest names differ")
    try:
        return store.put_manifest(body)
    except PackageValidationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except FileExistsError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.put("/{name}/package", response_model=StoreMutation)
async def put_skill_package(
    name: str,
    file: Annotated[UploadFile, File()],
    store: SkillStoreDep,
) -> StoreMutation:
    content = await file.read()
    try:
        descriptor = store.validate_zip(content)
        if descriptor.name != name:
            raise HTTPException(status_code=409, detail="Path and package names differ")
        return store.put_zip(content)
    except PackageValidationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except FileExistsError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    finally:
        await file.close()


def _set_enabled(store: UserSkillStore, name: str, *, enabled: bool) -> StoreMutation:
    try:
        return store.set_enabled(name, enabled=enabled)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Skill not found") from error
    except PermissionError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
