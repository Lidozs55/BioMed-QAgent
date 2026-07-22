import { UploadSimpleIcon } from "@phosphor-icons/react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { DatabaseDraft } from "@/lib/databaseDraft";
import { hasDatabaseErrors, validateDatabaseDraft } from "@/lib/databaseDraft";
import type { SkillDetail, SkillManifest, SkillValidation } from "@/hooks/useAPI";

/* ------------------------------------------------------------------ */
/*  Props                                                             */
/* ------------------------------------------------------------------ */
export interface SettingsDialogsProps {
  databaseDraft: DatabaseDraft | null;
  editingDatabase: SkillManifest | null;
  skillDetail: SkillDetail | null;
  pendingDelete: { kind: "database" | "skill"; name: string; label: string } | null;
  pendingUpload: { file: File; validation: SkillValidation } | null;
  uploading: boolean;
  onDatabaseDraftChange: (draft: DatabaseDraft | null) => void;
  onEditingDatabaseChange: (db: SkillManifest | null) => void;
  onSkillDetailChange: (detail: SkillDetail | null) => void;
  onPendingDeleteChange: (item: { kind: "database" | "skill"; name: string; label: string } | null) => void;
  onPendingUploadChange: (item: { file: File; validation: SkillValidation } | null) => void;
  onSaveDatabase: (draft: DatabaseDraft, editing: SkillManifest | null) => Promise<void>;
  onConfirmDelete: () => Promise<void>;
  onConfirmUpload: () => Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */
export function SettingsDialogs({
  databaseDraft,
  editingDatabase,
  skillDetail,
  pendingDelete,
  pendingUpload,
  uploading,
  onDatabaseDraftChange,
  onSkillDetailChange,
  onPendingDeleteChange,
  onPendingUploadChange,
  onSaveDatabase,
  onConfirmDelete,
  onConfirmUpload,
}: SettingsDialogsProps) {
  const dbValidation = databaseDraft ? validateDatabaseDraft(databaseDraft) : null;
  const dbHasErrors = dbValidation !== null && hasDatabaseErrors(dbValidation);

  return (
    <>
      {/* Database editor dialog */}
      <Dialog open={databaseDraft !== null} onOpenChange={(next) => { if (!next) onDatabaseDraftChange(null); }}>
        <DialogContent className="max-h-[calc(100svh-2rem)] overflow-auto">
          <DialogHeader>
            <DialogTitle>{editingDatabase ? "编辑数据库" : "新建数据库"}</DialogTitle>
            <DialogDescription>编辑完整 URL 和基础请求模板；保存时保持声明式操作定义。</DialogDescription>
          </DialogHeader>
          {databaseDraft && (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="database-name">Name</FieldLabel>
                <Input id="database-name" disabled={editingDatabase !== null} value={databaseDraft.name} onChange={(event) => onDatabaseDraftChange({ ...databaseDraft, name: event.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="database-display">Display name</FieldLabel>
                <Input id="database-display" value={databaseDraft.displayName} onChange={(event) => onDatabaseDraftChange({ ...databaseDraft, displayName: event.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="database-description">Description</FieldLabel>
                <Textarea id="database-description" value={databaseDraft.description} onChange={(event) => onDatabaseDraftChange({ ...databaseDraft, description: event.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="database-url">Base URL</FieldLabel>
                <Input id="database-url" value={databaseDraft.url} onChange={(event) => onDatabaseDraftChange({ ...databaseDraft, url: event.target.value })} />
              </Field>
              <Field data-invalid={dbValidation !== null && dbValidation.method !== null || undefined}>
                <FieldLabel htmlFor="database-method">Method</FieldLabel>
                <Input id="database-method" value={databaseDraft.method} onChange={(event) => onDatabaseDraftChange({ ...databaseDraft, method: event.target.value })} aria-invalid={dbValidation !== null && dbValidation.method !== null || undefined} />
                {dbValidation?.method && <FieldError>{dbValidation.method}</FieldError>}
              </Field>
              <Field>
                <FieldLabel htmlFor="database-operation">Search operation</FieldLabel>
                <Input id="database-operation" value={databaseDraft.operation} onChange={(event) => onDatabaseDraftChange({ ...databaseDraft, operation: event.target.value })} />
              </Field>
              <Field data-invalid={dbValidation !== null && dbValidation.query !== null || undefined}>
                <FieldLabel htmlFor="database-query">Query template</FieldLabel>
                <Textarea id="database-query" value={databaseDraft.query} onChange={(event) => onDatabaseDraftChange({ ...databaseDraft, query: event.target.value })} aria-invalid={dbValidation !== null && dbValidation.query !== null || undefined} />
                {dbValidation?.query && <FieldError>{dbValidation.query}</FieldError>}
              </Field>
              <Field data-invalid={dbValidation !== null && dbValidation.headers !== null || undefined}>
                <FieldLabel htmlFor="database-headers">Headers template</FieldLabel>
                <Textarea id="database-headers" value={databaseDraft.headers} onChange={(event) => onDatabaseDraftChange({ ...databaseDraft, headers: event.target.value })} aria-invalid={dbValidation !== null && dbValidation.headers !== null || undefined} />
                {dbValidation?.headers && <FieldError>{dbValidation.headers}</FieldError>}
              </Field>
              <Field data-invalid={dbValidation !== null && dbValidation.body !== null || undefined}>
                <FieldLabel htmlFor="database-body">Body template</FieldLabel>
                <Textarea id="database-body" value={databaseDraft.body} onChange={(event) => onDatabaseDraftChange({ ...databaseDraft, body: event.target.value })} aria-invalid={dbValidation !== null && dbValidation.body !== null || undefined} />
                {dbValidation?.body && <FieldError>{dbValidation.body}</FieldError>}
              </Field>
              <DialogFooter>
                <Button variant="outline" onClick={() => onDatabaseDraftChange(null)}>取消</Button>
                <Button disabled={dbHasErrors} onClick={() => void onSaveDatabase(databaseDraft, editingDatabase)}>保存数据库</Button>
              </DialogFooter>
            </FieldGroup>
          )}
        </DialogContent>
      </Dialog>

      {/* Skill detail dialog */}
      <Dialog open={skillDetail !== null} onOpenChange={(next) => { if (!next) onSkillDetailChange(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{skillDetail?.manifest.display_name ?? "技能详情"}</DialogTitle>
            <DialogDescription>当前版本、操作与加载状态。</DialogDescription>
          </DialogHeader>
          {skillDetail && (
            <Card>
              <CardHeader>
                <CardTitle>v{skillDetail.current_version}</CardTitle>
                <CardDescription>{skillDetail.manifest.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-2">
                  <div>操作：{skillDetail.manifest.operations.join(", ") || "无"}</div>
                  <div>可用：{skillDetail.available ? "是" : "否"}</div>
                  {skillDetail.load_error && (
                    <Alert variant="destructive">
                      <AlertTitle>加载失败</AlertTitle>
                      <AlertDescription>{skillDetail.load_error}</AlertDescription>
                    </Alert>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <AlertDialog open={pendingDelete !== null} onOpenChange={(next) => { if (!next) onPendingDeleteChange(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              删除“{pendingDelete?.label}”及其用户版本后无法恢复。内置项目不会提供删除操作。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={(event) => { event.preventDefault(); void onConfirmDelete(); }}>
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Upload confirmation dialog */}
      <AlertDialog open={pendingUpload !== null} onOpenChange={(next) => { if (!next && !uploading) onPendingUploadChange(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认安装技能</AlertDialogTitle>
            <AlertDialogDescription>
              已验证 {pendingUpload?.validation.skill.display_name} v{pendingUpload?.validation.skill.version}。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingUpload?.validation.warning && (
            <Alert>
              <UploadSimpleIcon />
              <AlertTitle>本地代码执行警告</AlertTitle>
              <AlertDescription>{pendingUpload.validation.warning}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={uploading}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={uploading} onClick={(event) => { event.preventDefault(); void onConfirmUpload(); }}>
              {uploading && <Spinner data-icon="inline-start" />}
              确认安装
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
