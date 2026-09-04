# docs/ 误裁剪与 data/ 数据事故 · 恢复计划（2026-09-04）

> 状态：**待执行**（约定 2026-09-05 处理；当天为论文 deadline，本文档先固化事实与方案）。
> 执行人：任意 agent 或人工，执行前先读完本文。
> 结论先行：dev 的 docs/ 大部分被静默误删（可从 git 历史恢复）；data/ 运行期数据
> 被误删（git 不可恢复，见 §3）；main 被热修 PR 带回了已裁剪内容（见 §4）。

## 0. 硬性约束（事故后新增，永久生效）

1. **裁剪 / 恢复 / 发布分支操作必须在专用 worktree 中进行**：
   `git worktree add ../BioMedQAgent-<branch> <branch>`；禁止在主工作目录执行
   任何 `git rm` / `checkout --ours` / 清理类操作——主工作目录里堆着大量未跟踪
   的运行期数据（`data/`、编辑器草稿），一切误操作都直接作用于真实数据。
2. **裁剪必须使用专门用于裁剪的 branch，PR 合并后立即删除该分支**。
3. **禁止删除任何未跟踪内容**。未跟踪 = git 无法恢复。无法判断是否未跟踪时，
   先 `git ls-files --error-unmatch <path>` 验证。
4. 提交前必须 `git branch --show-current` 确认分支（本轮曾在 main 上误提交两次，
   均靠 cherry-pick + reset 补救）。

## 1. 事故一：dev 的 docs/ 被静默裁剪（可从 git 恢复）

**根因**：为给打包热修开 PR（#18），执行了 `git merge origin/main`（bcf0ff0a）。
彼时 main 是 release/v1.0.0 裁剪后的树：凡 main 侧删除、dev 侧与合并基完全一致
（即被 4654e0f5 原样恢复、无人改动）的内部文档，git 按"干净删除"处理，**静默
应用到了 dev**；只有 6 个 dev 有本地修改的文件走了 modify/delete 冲突被保留。

**丢失面**（对照 506b69d6 的 docs/ 树，恢复的基准版本）：
`ARCHITECTURE.md`、`AGENT_API_QUICKSTART.md`、`AGENT_SELF_MODIFICATION_CHARTER.md`、
`ARCHITECTURE_REVIEW.md`、`DEVELOPER_QUICKSTART.md`、`FEATURES.md`、`ISSUES.md`、
`README.md`、`RELEASE_PRUNE_CHECKLIST.md`、`TODO.md`、`git-hooks.md`、`packaging.md`、
`adr/`、`archive/`、`audit/`、`handoffs/`、`images/`、`migration/`、`plans/`、
`reports/`、`architecture/` 下的其余主题章节。

**幸存面**（有本地修改而走了冲突，或系冲突后新文件）：
`architecture/agent-frontend.md`、`evaluation/FINAL_REPORT_HANDOFF.md` 及
`evaluation/gold6-*` 证据、`latex/`（且 latex 章节含协作者 3bdbee41 的**更新版**，
恢复时严禁用旧版覆盖）。

**恢复步骤**（在专用 worktree 中，见 §0）：

```bash
git worktree add -b docs-recovery ../BioMedQAgent-docs-recovery origin/dev
cd ../BioMedQAgent-docs-recovery
# 基准 = 506b69d6（误删前最后一个完整 dev 状态）
git checkout 506b69d6 -- docs/ARCHITECTURE.md docs/AGENT_API_QUICKSTART.md \
  docs/AGENT_SELF_MODIFICATION_CHARTER.md docs/ARCHITECTURE_REVIEW.md \
  docs/DEVELOPER_QUICKSTART.md docs/FEATURES.md docs/ISSUES.md docs/README.md \
  docs/RELEASE_PRUNE_CHECKLIST.md docs/TODO.md docs/git-hooks.md \
  docs/packaging.md docs/adr docs/archive docs/audit docs/handoffs \
  docs/images docs/migration docs/plans docs/reports docs/architecture
# 注意：不要 checkout docs/latex —— 3bdbee41 的章节更新版必须保留。
# 恢复后在 RELEASE_PRUNE_CHECKLIST.md 顶部写入 §0 的硬性约束再提交。
git push -u origin docs-recovery   # 开 PR → dev；合并后删除分支与 worktree
```

## 2. 事故二：data/ 运行期数据被误删（git 不可恢复）

主工作目录误执行 `rm -rf data`（工作目录停在仓库根，目标本是 bundle 内的测试
数据），删除了 dev 实例运行期数据：`data/settings/`（模型凭据）、`data/workspaces/`、
`data/output/tasks/`（任务事件流与产物）。这些从未入 git，rm 也不走回收站。

- `data/gold`、`data/gold-runs` 同样未被 git 跟踪 → 无法从 git 恢复；仅在
  dfd63e04 之前的历史快照中有**过期版本**的 blob，如需可从对象库按需找回。
- 缓解：检查 Windows 文件历史 / 恢复工具；在 Web 设置中重新配置模型凭据。
- 教训即 §0 第 3 条：`data/` 及一切未跟踪内容永不在任何清理命令的路径里。

## 3. main 被热修 PR 带回已裁剪内容（待裁剪）

dev→main 的直接热修 PR（#18–#23）把 main 侧已裁剪的内容重新合入 main：
`docs/**`（41 个文件，含 latex 论文与 gold 评测证据）、
`scripts/generate-gold6-10-session-report.mjs`、`data/gold`（未跟踪残留，不入库）、
`.husky/`。**bundle 产物不受影响**（打包器不 stage 这些路径）。

修复（同样在专用 worktree 中，PR 合并后删分支）：

```bash
git worktree add -b release/prune-hotfix ../BioMedQAgent-prune-hotfix origin/main
cd ../BioMedQAgent-prune-hotfix
git rm -rf docs scripts/generate-gold6-10-session-report.mjs
# .husky 若存在则一并 git rm；逐项对照 RELEASE_PRUNE_CHECKLIST.md（见 §1 恢复件）
git push -u origin release/prune-hotfix   # PR → main；合并后删除分支与 worktree
```

## 4. 流程根因与再发防止

- dev→main 的**任何** PR 都会把 dev 独有文件带入 main。因此凡面向 main 的修复，
  一律在专用 worktree 中现切的裁剪分支发起，禁止直接 dev→main 开热修 PR。
- main 合回 dev 时，裁剪删除会以"干净删除"静默落地（本次事故一）——dev 侧合并
  main 后必须 `git diff <merge-base> HEAD --name-status -- docs/ | grep ^D` 审计。
- 本文随 docs/ 的恢复一并保留在 dev；面向 main 时随裁剪剪除。
