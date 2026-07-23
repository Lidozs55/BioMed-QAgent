import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ModelForm } from "@/components/ModelForm";
import { SettingsDialogs } from "@/components/SettingsDialogs";
import { DatabasesTabContent, SkillsTabContent } from "@/components/DataTabs";
import { EMPTY_DATABASE, databaseManifest, hasDatabaseErrors, parseHttpMethod, parseJsonBody, parseJsonTemplate, validateDatabaseDraft, type DatabaseDraft } from "@/lib/databaseDraft";
import type { ModelSettings, SettingsAPIClient, SkillDetail, SkillManifest, SkillValidation, VendorInfo } from "@/hooks/useAPI";

interface SettingsPanelProps {
  open: boolean; onOpenChange: (open: boolean) => void; api: SettingsAPIClient;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "请求失败";
}

export function SettingsPanel({ open, onOpenChange, api }: SettingsPanelProps) {
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [vendors, setVendors] = useState<VendorInfo[]>([]);
  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [skillFilter, setSkillFilter] = useState("");
  const [databaseDraft, setDatabaseDraft] = useState<DatabaseDraft | null>(null);
  const [editingDatabase, setEditingDatabase] = useState<SkillManifest | null>(null);
  const [pendingUpload, setPendingUpload] = useState<{ file: File; validation: SkillValidation } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: "database" | "skill"; name: string; label: string } | null>(null);
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null);
  const [uploading, setUploading] = useState(false);

  const databases = skills.filter((s) => s.user_selectable && s.supported_sources.length > 0);

  const refreshSkills = useCallback(async () => setSkills(await api.fetchSkills()), [api]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, v, sk] = await Promise.all([api.fetchSettings(), api.fetchVendors(), api.fetchSkills()]);
      setSettings(s); setVendors(v); setSkills(sk);
    } catch (e) { toast.error("设置加载失败", { description: errMsg(e) }); }
    finally { setLoading(false); }
  }, [api]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(t);
  }, [load, open]);

  const mutateSkill = async (action: () => Promise<void>, msg: string) => {
    try { await action(); await refreshSkills(); toast.success(msg); }
    catch (e) { toast.error("操作失败", { description: errMsg(e) }); }
  };

  const confirmUpload = async () => {
    if (!pendingUpload) return;
    setUploading(true);
    try {
      await api.uploadSkill(pendingUpload.file);
      setPendingUpload(null);
      await refreshSkills();
      toast.success("技能已安装");
    } catch (e) { toast.error("技能安装失败", { description: errMsg(e) }); }
    finally { setUploading(false); }
  };

  const onEditDB = async (db: SkillManifest) => {
    try {
      const detail = await api.fetchSkill(db.name);
      const op = detail.declarative_manifest?.operations[0];
      if (!detail.declarative_manifest || !op) throw new Error("缺少操作");
      setEditingDatabase(db);
      setDatabaseDraft({
        name: detail.declarative_manifest.name, displayName: detail.declarative_manifest.display_name,
        description: detail.declarative_manifest.description, url: op.url, operation: op.name,
        method: op.method, query: JSON.stringify(op.query ?? {}),
        headers: JSON.stringify(op.headers ?? {}), body: JSON.stringify(op.body ?? null),
      });
    } catch (e) { toast.error("数据库详情加载失败", { description: errMsg(e) }); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100svh-2rem)] min-h-0 w-[min(90rem,calc(100vw-2rem))] max-w-none sm:max-w-none flex-col" showCloseButton>
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>管理模型连接、数据库目录和 Agent 技能。</DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-8 w-72" /><Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <Tabs defaultValue="model" className="min-h-0 flex-1">
            <TabsList>
              <TabsTrigger value="model">Model</TabsTrigger>
              <TabsTrigger value="databases">Databases</TabsTrigger>
              <TabsTrigger value="skills">Skills</TabsTrigger>
            </TabsList>
            <TabsContent value="model" className="min-h-0 overflow-auto py-2">
              <ModelForm key={settings?.base_url ?? 'fresh'} api={api} settings={settings} vendors={vendors} onSaved={(u) => setSettings(u)} />
            </TabsContent>
            <TabsContent value="databases" className="min-h-0 overflow-auto py-2">
              <DatabasesTabContent databases={databases} api={api} onRefresh={refreshSkills}
                onEditDB={onEditDB}
                onDeleteDB={(db) => setPendingDelete({ kind: "database", name: db.name, label: db.display_name })}
                onNewDB={() => { setEditingDatabase(null); setDatabaseDraft(EMPTY_DATABASE); }}
                onUploadValidation={async (file) => {
                  try { setPendingUpload({ file, validation: await api.validateSkill(file) }); }
                  catch (e) { toast.error("文件验证失败", { description: e instanceof Error ? e.message : String(e) }); }
                }} />
            </TabsContent>
            <TabsContent value="skills" className="min-h-0 overflow-auto py-2">
              <SkillsTabContent skills={skills} skillFilter={skillFilter} onFilterChange={setSkillFilter}
                api={api} onRefresh={refreshSkills}
                onViewDetail={async (sk) => { try { setSkillDetail(await api.fetchSkill(sk.name)); } catch (e) { toast.error("技能详情加载失败", { description: e instanceof Error ? e.message : String(e) }); } }}
                onDeleteSkill={(sk) => setPendingDelete({ kind: "skill", name: sk.name, label: sk.display_name })}
                onUploadValidation={async (file) => {
                  try { setPendingUpload({ file, validation: await api.validateSkill(file) }); }
                  catch (e) { toast.error("文件验证失败", { description: e instanceof Error ? e.message : String(e) }); }
                }} />
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
      <SettingsDialogs
        databaseDraft={databaseDraft} editingDatabase={editingDatabase}
        skillDetail={skillDetail} pendingDelete={pendingDelete}
        pendingUpload={pendingUpload} uploading={uploading}
        onDatabaseDraftChange={(d) => { setDatabaseDraft(d); if (!d) setEditingDatabase(null); }}
        onEditingDatabaseChange={setEditingDatabase}
        onSkillDetailChange={setSkillDetail}
        onPendingDeleteChange={setPendingDelete}
        onPendingUploadChange={setPendingUpload}
        onSaveDatabase={async (draft, editing) => {
          try {
            const errors = hasDatabaseErrors(validateDatabaseDraft(draft));
            if (errors) {
              throw new Error("Please fix field errors before saving");
            }
            if (editing) await api.updateDatabase(editing.name, {
              display_name: draft.displayName, description: draft.description,
              operation: { name: draft.operation, description: `Search ${draft.displayName}`, method: parseHttpMethod(draft.method), url: draft.url, query: parseJsonTemplate(draft.query), headers: parseJsonTemplate(draft.headers), body: parseJsonBody(draft.body) },
            });
            else await api.createDatabase(databaseManifest(draft));
            setDatabaseDraft(null); setEditingDatabase(null);
            await refreshSkills();
            toast.success("数据库目录已更新");
          } catch (e) { toast.error("数据库保存失败", { description: errMsg(e) }); }
        }}
        onConfirmDelete={async () => {
          if (!pendingDelete) return;
          const t = pendingDelete;
          setPendingDelete(null);
          await mutateSkill(() => t.kind === "database" ? api.deleteDatabase(t.name) : api.deleteSkill(t.name), t.kind === "database" ? "数据库已删除" : "技能已删除");
        }}
        onConfirmUpload={confirmUpload}
      />
    </Dialog>
  );
}
