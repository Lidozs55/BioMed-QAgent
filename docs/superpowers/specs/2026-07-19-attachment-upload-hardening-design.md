# Attachment Upload Hardening Design

## Context

BioMed Q-Agent already has an initial end-to-end file import path:

- `AgentComposer` selects files and starts an IMPORT task.
- `POST /api/v1/import/tasks` accepts multipart uploads.
- The IMPORT AgentLoop normalizes uploaded data into the local cache.

This change completes the homepage attachment experience and hardens the
backend admission boundary. It deliberately reuses the existing IMPORT mode
and cache instead of adding a second upload system.

## Goals

1. Make the `+` attachment entry on the homepage fully usable and consistent
   with the project's shadcn component patterns.
2. Let users select multiple files, inspect the pending list, remove files,
   optionally add a note, and submit one IMPORT task.
3. Preserve the selected files and note when submission fails so the user can
   retry without selecting them again.
4. Ensure the IMPORT Agent never starts before every uploaded file has been
   validated and durably placed in the task's `source_assets/` directory.
5. Keep the existing limits: at most 10 files per request and at most 10 MiB
   per file.

## Non-goals

- Image understanding or image-specific preview.
- Resumable or chunked browser uploads.
- A standalone upload library, upload history, or reusable upload IDs.
- Adding binary attachment data to durable events or messages.
- Changing how imported datasets are normalized or queried from local cache.

## User Interaction

The homepage composer and the bottom conversation composer share the same
`AgentComposer` component.

1. Clicking `+` opens the existing shadcn `DropdownMenu`.
2. Selecting `上传文件到本地缓存` opens a native multiple-file picker.
3. Selected files are shown above the composer controls with the existing
   shadcn `AttachmentGroup` and `Attachment` primitives. Each item shows its
   name and formatted size and has an accessible remove action.
4. Files are deduplicated by sanitized upload name, matching the backend's
   filename identity. Selecting a duplicate does not create a second item.
5. While files are selected, the text area becomes an optional import note.
   Data-source selection is hidden because IMPORT tasks do not use public
   database selections.
6. Clicking send, or pressing Enter without Shift, submits the files and note.
   Shift+Enter inserts a newline.
7. During upload/admission, the composer is pending and cannot submit twice.
8. On success, the note and file list are cleared and the accepted IMPORT task
   becomes active through the existing runtime-controller handoff.
9. On failure, the error is shown through the existing draft error alert and
   the note and file list remain available for retry.

The attachment UI will use existing shadcn components and semantic tokens. No
new bespoke attachment chip component will be introduced.

## HTTP Contract

The existing endpoint remains authoritative:

```text
POST /api/v1/import/tasks
Content-Type: multipart/form-data

request_id: string, required
input: string, optional
files: repeated file part, 1..10
```

Success returns the existing `TaskRunAccepted` response with HTTP 202. Existing
validation status codes remain:

- 422 for missing files, too many files, invalid names, or duplicate names.
- 413 when a file exceeds 10 MiB.
- 429 when the runtime queue is full.
- 503 when the runtime is unavailable.

The frontend continues to send `FormData` without manually setting the
`Content-Type` header so the browser supplies the multipart boundary.

## Backend Admission Flow

The route will change from "create task, then stream files" to a staged flow:

1. Validate the request-level file count and sanitized names.
2. Create a request-scoped temporary directory under the configured task data
   area, not the process working directory.
3. Stream each upload into that directory in 64 KiB chunks while enforcing the
   10 MiB limit.
4. If any validation or write fails, close uploads, delete the temporary
   directory, and return without creating a task.
5. After every file is complete, create the IMPORT task through `TaskManager`.
6. Move the staged files into the accepted task's `source_assets/` directory
   before yielding control back to the executor.
7. Clean the staging directory in a `finally` block.

The route remains responsible for filename sanitization and upload limits. A
small focused helper may own staging and cleanup so the route is testable
without duplicating file-system logic.

Because the runtime can begin executing immediately after admission, task
creation and source-asset publication must share an explicit synchronization
boundary. The implementation will add the smallest runtime-facing mechanism
needed to publish prepared source assets before the queued run becomes
executable; it will not depend on event-loop scheduling assumptions.

## Frontend State Boundary

`AgentComposer` owns the ephemeral browser `File[]` selection because files are
not serializable application state. The parent owns the asynchronous import
request and error reporting.

The submit callback becomes asynchronous so the composer clears attachments
only after it resolves successfully. Rejection leaves `pendingFiles` intact.
This avoids duplicating `File[]` in Zustand and keeps existing task projections
free of binary browser objects.

## Error Handling and Cleanup

- Frontend validation mirrors the backend count and size limits for immediate
  feedback, while the backend remains authoritative.
- A failed frontend request does not clear files or the note.
- A failed backend validation creates no durable task.
- Partial staged files and staging directories are removed on every failure.
- Queue-full and runtime-unavailable errors occur only after uploads are fully
  staged; staging is still cleaned before returning the error.
- Accepted task directories are not deleted by the upload route after task
  admission; their lifecycle remains owned by `TaskManager` and
  `TaskRepository`.

## Testing

### Frontend

- Selecting one or multiple files renders shadcn attachment items.
- Duplicate sanitized names are not added twice.
- Removing an item updates the pending selection.
- Files over 10 MiB and selections over 10 files show a visible error and are
  not submitted.
- A successful import clears files and note exactly once.
- A rejected import keeps files and note for retry.
- Enter and send-button behavior both use the import callback when files exist.

### Backend

- Valid multipart uploads create an IMPORT task with complete source assets.
- Missing, duplicate, excessive-count, and oversized uploads create no task.
- Partial files and staging directories are cleaned after validation or I/O
  failure.
- The executor cannot observe the task before all source assets are present.
- Existing import API and Import AgentLoop tests remain green.

## Parallel Implementation Boundary

Two agents can work independently in the same feature worktree:

- Frontend agent: `AgentComposer`, `ChatPanel`, API/client typing as needed, and
  Vitest coverage. It must use the shadcn skill and existing attachment
  primitives.
- Backend agent: multipart staging/admission synchronization, route helpers,
  and pytest coverage.

They must not edit each other's files. The primary agent will integrate both
changes, resolve shared contract details, run all quality gates, and own the
single feature merge.
