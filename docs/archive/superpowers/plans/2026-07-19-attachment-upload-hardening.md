# Attachment Upload Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the shadcn-based attachment picker and make multipart IMPORT task admission atomic with respect to source-asset publication.

**Architecture:** The frontend keeps ephemeral `File[]` state inside `AgentComposer`, delegates the asynchronous import request to `ChatPanel`, and clears files only after success. The backend stages and validates multipart files before task creation, then uses a narrow `TaskManager.create_task(..., prepare_task=...)` hook under the admission lock to publish source assets after snapshot creation but before the run is queued.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, Tailwind CSS v4, shadcn/ui base-nova; Python 3.12, FastAPI, pytest, uv.

## Global Constraints

- Use pnpm, never npm.
- Use existing shadcn `Attachment`, `AttachmentGroup`, `AttachmentAction`, `DropdownMenu`, `Button`, `Textarea`, and `Alert` components; do not create a bespoke attachment chip.
- Keep at most 10 files per import request, at most 500 MiB per file, and at
  most 2 GiB total.
- Preserve files and note after a rejected upload; clear them only after success.
- The IMPORT Agent must not observe a queued run before every source asset is fully published.
- Binary file data must not enter durable messages or event payloads.
- Add tests before implementation changes and do not suppress Python or TypeScript type errors.

---

### Task 1: Frontend attachment interaction and retry-safe state

**Files:**
- Modify: `frontend/src/components/AgentComposer.tsx`
- Modify: `frontend/src/components/ChatPanel.tsx`
- Test: `frontend/src/test/chat-panel.test.tsx`
- Test: `frontend/src/test/api.test.ts` only if API-client behavior requires an assertion

**Interfaces:**
- Consumes: `uploadFiles(files: File[], note: string): Promise<unknown>` from `ChatPanelProps`.
- Produces: `onSubmitFiles(files: File[], note: string): Promise<void>` on `AgentComposerProps`; the promise resolves only after the parent import request succeeds.
- Constants: `MAX_IMPORT_FILES = 10`, `MAX_IMPORT_FILE_BYTES = 500 * 1024 * 1024`, and `MAX_IMPORT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024` in the frontend component module.

- [ ] **Step 1: Add failing interaction tests**

Add Vitest cases that open the `添加附件` menu, select files through the hidden input, assert `data-slot="attachment"` entries render with file name and formatted size, remove one attachment, and verify the remaining `File[]` reaches `uploadFiles`.

- [ ] **Step 2: Add failing retry and limit tests**

Cover these exact outcomes: 11 selected files are rejected with a visible alert; a file of `500 * 1024 * 1024 + 1` bytes is rejected; a rejected `uploadFiles` promise retains both the selected attachment and note; a resolved promise clears them.

- [ ] **Step 3: Verify the new tests fail**

Run `pnpm test -- src/test/chat-panel.test.tsx src/test/api.test.ts` from `frontend/`. Expected: failures because attachments use custom spans, submission clears before resolution, and client-side limits are absent.

- [ ] **Step 4: Implement shadcn attachment composition**

Replace the custom attachment `<span>` and raw remove `<button>` with `AttachmentGroup`, `Attachment`, `AttachmentMedia`, `AttachmentContent`, `AttachmentTitle`, `AttachmentDescription`, `AttachmentActions`, and `AttachmentAction`. Use `FileIcon` and `XIcon` from the configured Phosphor icon library and set `data-icon` on icons inside buttons.

- [ ] **Step 5: Make submit asynchronous and retry-safe**

Change `onSubmitFiles` to return `Promise<void>`, make `handleSubmit` await it, set a component-local submit guard if necessary, and call `setPendingFiles([])` only on fulfillment. Keep `ChatPanel.submitFiles` responsible for the draft error and for clearing the note after success.

- [ ] **Step 6: Add mirrored client validation**

Before merging selected files, reject sanitized-name duplicates, totals over 10 files, files over 500 MiB, and combined size over 2 GiB through a new optional `onAttachmentError(message: string)` callback wired to `setDraftError`. Do not remove already valid pending files when a later selection is rejected.

- [ ] **Step 7: Run frontend checks**

Run `pnpm test -- src/test/chat-panel.test.tsx src/test/api.test.ts`, `pnpm lint`, `pnpm tsc`, and `pnpm build`. Expected: all pass with zero warnings/errors.

- [ ] **Step 8: Commit frontend task**

Commit only frontend files with `feat: complete attachment upload interaction`.

---

### Task 2: Backend staged upload and pre-queue source publication

**Files:**
- Modify: `backend/app/runtime/manager.py`
- Modify: `backend/app/api/routes.py`
- Test: `backend/tests/runtime/test_manager.py`
- Test: `backend/tests/api/test_import_api.py`

**Interfaces:**
- Produces: `TaskManager.create_task(request: StartTaskRequest, *, prepare_task: Callable[[str], Awaitable[None]] | None = None) -> TaskRunAccepted`.
- `prepare_task(task_id)` runs only for a newly created task, after its initial snapshot exists and before `run_queued` is appended or `_queue.put_nowait` is called.
- If `prepare_task` raises, `TaskManager` deletes the new task tree and re-raises; no request mapping or queued run may remain.

- [ ] **Step 1: Add failing TaskManager ordering tests**

Add a test with a blocking `prepare_task` callback proving the executor and queue cannot observe the run until the callback completes. Add a failure test proving a raising callback leaves no snapshot, request mapping, event, or queued run.

- [ ] **Step 2: Verify manager tests fail**

Run `uv run pytest tests/runtime/test_manager.py -k "prepare_task" -q` from `backend/`. Expected: failures because `create_task` does not yet accept the callback.

- [ ] **Step 3: Implement the pre-admission callback**

Add the typed callback parameter and thread it into `_create_and_admit_locked`. Invoke it after `save_snapshot` and before `_admit_run_locked`. Extend the existing rollback block so callback failure deletes the task tree and preserves the original exception, adding a rollback note only if deletion also fails.

- [ ] **Step 4: Add failing import API staging tests**

Extend `test_import_api.py` to assert oversized, duplicate, and excessive-count requests do not add a task; assert staged partial files are deleted; and use a probe executor/callback to prove all uploaded files already exist when the run becomes executable.

- [ ] **Step 5: Implement request-scoped staging**

Inject `TaskRepositoryDep` into `create_import_task`. Create a unique directory beneath `repository.tasks_dir / ".uploads"`, stream files there in 64 KiB chunks, and validate limits before calling `manager.create_task`. Pass an async `prepare_task(task_id)` callback that creates the task workdir with `base_dir=str(repository.tasks_dir)` and moves every completed staged file into `source_assets/` with `Path.replace`.

- [ ] **Step 6: Guarantee cleanup and upload closure**

Wrap staging/admission in `try/finally`; close every `UploadFile`; remove the request staging directory and remove `.uploads` only when empty. Validation, queue-full, runtime-unavailable, and filesystem failures must leave no staging files.

- [ ] **Step 7: Run backend checks**

Run `uv run pytest tests/api/test_import_api.py tests/runtime/test_manager.py -q` and `uv run ruff check app/ tests/ launcher.py`. Expected: all pass with zero warnings/errors.

- [ ] **Step 8: Commit backend task**

Commit only backend files with `fix: stage imports before task admission`.

---

### Task 3: Integration review and complete quality gates

**Files:**
- Modify only if integration failures require a surgical correction.

**Interfaces:**
- Consumes both task commits and the design at `docs/superpowers/specs/2026-07-19-attachment-upload-hardening-design.md`.
- Produces one verified feature branch ready to merge.

- [ ] **Step 1: Review task diffs for spec compliance and code quality**

Confirm the frontend uses shadcn attachments and preserves rejected selections. Confirm backend publication occurs before `run_queued` and queue insertion, including rollback behavior.

- [ ] **Step 2: Run full frontend gates**

Run `pnpm test`, `pnpm lint`, `pnpm tsc`, and `pnpm build` from `frontend/`.

- [ ] **Step 3: Run full backend gates**

Run `uv run pytest` and `uv run ruff check app/ tests/ launcher.py` from `backend/`.

- [ ] **Step 4: Verify backend startup**

Clear backend `__pycache__` directories, start `uv run uvicorn app.main:app --reload`, verify startup on `127.0.0.1:8000`, then stop it cleanly.

- [ ] **Step 5: Update documentation if implementation details changed**

Keep `docs/CACHE_DESIGN.md`, the feature design, and the code consistent. Do not add a new TODO unless work is intentionally deferred.

- [ ] **Step 6: Commit integration corrections**

If needed, commit with `fix: integrate attachment upload hardening`; otherwise leave the two task commits unchanged.
