# Phase 7 T6 — toolLabels / 模型搜索框 / 通用 UI 改进

Branch: `feat/phase7-t56-frontend-misc` · Commit: `8386bae`

## §3.2 toolLabels — VERIFIED ALREADY COMPLETE (no code change needed)

`frontend/src/components/conversation/toolLabels.ts` already ships
`invoke_skill` / `find_skill` formatters ("调用 {skill}" / "检索 技能"), and
`toolRenderers.tsx` routes both to `SkillMarker`. `toolLabels.test.ts` has 19
passing tests including invoke_skill (with/without args) and find_skill — no
work required, verified only.

## §3.3 模型搜索框恢复 + LEGACY_MODELS 硬编码清理 — DONE

Backend reality check: `/api/v1/models` is a POST proxy (settings.py
`list_models`) that forwards to the configured OpenAI-compatible vendor and
returns `{models, total_count, api_source}`; `App.loadModels` fetches it and
passes the list into `ChatPanel → AgentComposer`.

- The search box already existed against the real endpoint
  (`AgentComposer` popover + `ModelSettingsSection`); the remaining hardcode was
  the dead `LEGACY_MODELS` DropdownMenu branch (only rendered when `models`
  prop was `undefined`, which never happens — App always passes an array).
- Removed `LEGACY_MODELS`, the legacy branch, the unused `model` state, and the
  radio-menu imports. The selector is now: `hasApiKey` → searchable popover
  (real endpoint list, or small offline fallback when the endpoint is
  unreachable/empty); no API key → "无可用模型" button opening settings.
- `lib/modelChoices.ts` (new): `OFFLINE_MODEL_FALLBACK` (4 Qwen ids, small,
  commented) + `resolveModelChoices(models, hasApiKey)`. Popover footer shows an
  "离线备选" hint when the fallback is active.

TDD: `test/agent-composer-models.test.tsx` (6 tests — pure resolver cases +
popover search over real models + offline fallback + no-legacy-dropdown),
red first, then implementation. Updated `test/chat-panel.test.tsx` legacy
"切换主模型" assertion to the new "未配置 API Key" affordance.

## §3.5 通用 UI 改进 — partial (scope discipline)

- **缓存导出按钮**: ALREADY COMPLETE in base — `App.exportCache` (uses
  `api.getCacheExportUrl()` → `GET /api/v1/cache/export`) wired to BOTH
  `SessionSidebar` (导出缓存) and `SettingsPanel → GeneralSettingsSection`
  (导出缓存). Existing coverage: `session-sidebar.test.tsx` (555). Verified
  only.
- **command/menubar**: SKIPPED. No existing CommandDialog/menubar pattern in
  the app (`ui/command.tsx` shadcn primitive exists but is unused; base-ui
  command root is not wired). Building a command palette from scratch is a
  multi-component effort with no user requirement behind it — out of scope for
  this cheap-high-value pass. Documented as deferred.
- **对话路由 (conversation routing)**: DEFERRED. The app has no router
  (single-page App shell); URL-path routing + task deep-linking would need a
  router integration and touches selection/replay semantics — not trivially
  small. Documented as deferred with rationale in docs/TODO.md (Phase 7 P2).

## Gates

- `pnpm lint`: 0 warnings · `pnpm tsc`: 0 errors · `pnpm build`: OK
- `pnpm test`: 711 passed / 45 files (+6 tests, 1 new file vs T5's 705/44)
