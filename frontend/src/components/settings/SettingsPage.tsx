import { useCallback, useEffect, useState } from "react";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { toast } from "sonner";

import { SettingsSearch } from "@/components/settings/SettingsSearch";
import {
  DEFAULT_SETTINGS_SECTION,
  getSettingsNavItem,
  SETTINGS_NAV_GROUPS,
} from "@/components/settings/settingsNavConfig";
import { AppearanceSettingsSection } from "@/components/settings/sections/AppearanceSettingsSection";
import { DatabaseSettingsSection } from "@/components/settings/sections/DatabaseSettingsSection";
import { EditorSettingsSection } from "@/components/settings/sections/EditorSettingsSection";
import { GeneralSettingsSection } from "@/components/settings/sections/GeneralSettingsSection";
import { ModelSettingsSection } from "@/components/settings/sections/ModelSettingsSection";
import { PersonalizationSettingsSection } from "@/components/settings/sections/PersonalizationSettingsSection";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  EMPTY_DATABASE,
  databaseManifest,
  hasDatabaseErrors,
  parseHttpMethod,
  parseJsonBody,
  parseJsonTemplate,
  validateDatabaseDraft,
  type DatabaseDraft,
} from "@/lib/databaseDraft";
import { cn } from "@/lib/utils";
import type {
  DatabaseItem,
  ModelSettings,
  SettingsAPIClient,
} from "@/hooks/useAPI";

export interface SettingsPageProps {
  api: SettingsAPIClient;
  onClose: () => void;
  onExportCache?: () => void;
}

const SECTION_DESCRIPTIONS: Record<string, string> = {
  model: "管理模型供应商与维护模型列表，并查看当前模型信息。",
  databases: "管理可选择的声明式检索数据库。",
  editor: "调整消息发送方式与上下文用量指示。",
  appearance: "调整主题模式、强调色与界面字体。",
  general: "管理本地数据与查看版本信息。",
  personalization: "配置适用于所有任务的额外指令与默认回复语气。",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败";
}

export function SettingsPage({ api, onClose, onExportCache }: SettingsPageProps) {
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<ModelSettings | null>(null);

  const [databases, setDatabases] = useState<DatabaseItem[]>([]);
  const [databaseDraft, setDatabaseDraft] = useState<DatabaseDraft | null>(null);
  const [editingDatabase, setEditingDatabase] = useState<DatabaseItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    name: string;
    label: string;
  } | null>(null);

  const [activeSection, setActiveSection] = useState(DEFAULT_SETTINGS_SECTION);
  const [highlight, setHighlight] = useState<{ anchor: string; nonce: number } | null>(null);

  const refreshDatabases = useCallback(async () => {
    setDatabases(await api.fetchDatabases());
  }, [api]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextSettings, nextDatabases] = await Promise.all([
        api.fetchSettings(),
        api.fetchDatabases(),
      ]);
      setSettings(nextSettings);
      setDatabases(nextDatabases);
    } catch (error) {
      toast.error("设置加载失败", { description: errorText(error) });
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const handleActivated = useCallback((updated: ModelSettings) => {
    setSettings(updated);
  }, []);

  const mutateDatabase = useCallback(
    async (action: () => Promise<unknown>, success: string) => {
      try {
        await action();
        await refreshDatabases();
        toast.success(success);
      } catch (error) {
        toast.error("操作失败", { description: errorText(error) });
      }
    },
    [refreshDatabases],
  );

  const editDatabase = useCallback(
    async (database: DatabaseItem) => {
      try {
        const detail = await api.fetchDatabase(database.id);
        const operation = detail.declarative_manifest?.operations[0];
        if (!detail.declarative_manifest || !operation) throw new Error("缺少操作");
        setEditingDatabase(database);
        setDatabaseDraft({
          name: detail.declarative_manifest.name,
          displayName: detail.declarative_manifest.display_name,
          description: detail.declarative_manifest.description,
          url: operation.url,
          operation: operation.name,
          method: operation.method,
          query: JSON.stringify(operation.query ?? {}),
          headers: JSON.stringify(operation.headers ?? {}),
          body: JSON.stringify(operation.body ?? null),
        });
      } catch (error) {
        toast.error("数据库详情加载失败", { description: errorText(error) });
      }
    },
    [api],
  );

  const saveDatabase = useCallback(async () => {
    if (!databaseDraft) return;
    try {
      if (hasDatabaseErrors(validateDatabaseDraft(databaseDraft))) {
        throw new Error("请先修正字段错误");
      }
      if (editingDatabase) {
        await api.updateDatabase(editingDatabase.id, {
          display_name: databaseDraft.displayName,
          description: databaseDraft.description,
          operation: {
            name: databaseDraft.operation,
            description: `Search ${databaseDraft.displayName}`,
            method: parseHttpMethod(databaseDraft.method),
            url: databaseDraft.url,
            query: parseJsonTemplate(databaseDraft.query),
            headers: parseJsonTemplate(databaseDraft.headers),
            body: parseJsonBody(databaseDraft.body),
          },
        });
      } else {
        await api.createDatabase(databaseManifest(databaseDraft));
      }
      setDatabaseDraft(null);
      setEditingDatabase(null);
      await refreshDatabases();
      toast.success("数据库目录已更新");
    } catch (error) {
      toast.error("数据库保存失败", { description: errorText(error) });
    }
  }, [api, databaseDraft, editingDatabase, refreshDatabases]);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    await mutateDatabase(
      () => api.deleteDatabase(target.name),
      "数据库已删除",
    );
  }, [api, mutateDatabase, pendingDelete]);

  const navigate = useCallback((section: string, anchor?: string) => {
    setActiveSection(section);
    if (anchor) {
      const nonce = Date.now();
      setHighlight({ anchor, nonce });
      window.setTimeout(() => {
        document
          .querySelector(`[data-anchor="${anchor}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 80);
    }
  }, []);

  const currentItem = getSettingsNavItem(activeSection);
  const sectionDescription = SECTION_DESCRIPTIONS[activeSection] ?? "";

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background text-foreground"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Button variant="ghost" size="sm" onClick={onClose}>
          <ArrowLeftIcon data-icon="inline-start" />
          返回应用
        </Button>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        <h1 className="truncate text-sm font-semibold">{currentItem?.label ?? "设置"}</h1>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-60 shrink-0 flex-col overflow-y-auto border-r bg-muted/25 p-3 md:flex">
          <SettingsSearch onNavigate={navigate} className="mb-5" />
          <nav aria-label="设置分类" className="space-y-5">
            {SETTINGS_NAV_GROUPS.map((group) => (
              <div key={group.id}>
                <p className="px-2 pb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                  {group.label}
                </p>
                <div className="space-y-0.5">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const active = activeSection === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        aria-current={active ? "page" : undefined}
                        onClick={() => navigate(item.id)}
                        className={cn(
                          "flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                          active
                            ? "bg-primary/10 font-medium text-primary"
                            : "text-foreground hover:bg-muted",
                        )}
                      >
                        <Icon className="size-4 shrink-0" />
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex gap-1 overflow-x-auto border-b px-3 py-2 md:hidden">
            {SETTINGS_NAV_GROUPS.flatMap((group) =>
              group.items.map((item) => {
                const Icon = item.icon;
                const active = activeSection === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigate(item.id)}
                    className={cn(
                      "flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium",
                      active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted",
                    )}
                  >
                    <Icon className="size-3.5" />
                    {item.label}
                  </button>
                );
              }),
            )}
          </div>

          <main className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-4xl px-5 py-8 sm:px-8">
              <header className="mb-8">
                <h2 className="text-2xl font-semibold tracking-tight">
                  {currentItem?.label ?? "设置"}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">{sectionDescription}</p>
              </header>

              {loading ? (
                <div className="space-y-4">
                  <Skeleton className="h-8 w-64" />
                  <Skeleton className="h-72 w-full" />
                  <Skeleton className="h-48 w-full" />
                </div>
              ) : (
                <>
                  {activeSection === "model" && (
                    <ModelSettingsSection
                      api={api}
                      settings={settings}
                      highlightAnchor={highlight?.anchor ?? null}
                      onActivated={handleActivated}
                    />
                  )}
                  {activeSection === "databases" && (
                    <DatabaseSettingsSection
                      databases={databases}
                      highlightAnchor={highlight?.anchor ?? null}
                      highlightNonce={highlight?.nonce ?? 0}
                      onNewDatabase={() => {
                        setEditingDatabase(null);
                        setDatabaseDraft(EMPTY_DATABASE);
                      }}
                      onEditDatabase={(database) => void editDatabase(database)}
                      onToggleEnabled={(database, enabled) =>
                        void mutateDatabase(
                          () => api.setDatabaseEnabled(database.id, enabled),
                          "数据库状态已更新",
                        )
                      }
                      onDeleteDatabase={(database) =>
                        setPendingDelete({
                          name: database.id,
                          label: database.name,
                        })
                      }
                    />
                  )}
                  {activeSection === "editor" && <EditorSettingsSection />}
                  {activeSection === "appearance" && <AppearanceSettingsSection />}
                  {activeSection === "personalization" && (
                    <PersonalizationSettingsSection api={api} />
                  )}
                  {activeSection === "general" && (
                    <GeneralSettingsSection onExportCache={onExportCache ?? (() => undefined)} />
                  )}
                </>
              )}
            </div>
          </main>
        </div>
      </div>

      {/* ---- Database editor dialog ---- */}
      <Dialog
        open={databaseDraft !== null}
        onOpenChange={(next) => {
          if (!next) setDatabaseDraft(null);
        }}
      >
        <DialogContent className="max-h-[calc(100svh-2rem)] overflow-auto">
          <DialogHeader>
            <DialogTitle>{editingDatabase ? "编辑数据库" : "新建数据库"}</DialogTitle>
            <DialogDescription>
              编辑完整 URL 和基础请求模板；保存时保持声明式操作定义。
            </DialogDescription>
          </DialogHeader>
          {databaseDraft && (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="database-name">Name</FieldLabel>
                <Input
                  id="database-name"
                  disabled={editingDatabase !== null}
                  value={databaseDraft.name}
                  onChange={(event) =>
                    setDatabaseDraft({ ...databaseDraft, name: event.target.value })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="database-display">Display name</FieldLabel>
                <Input
                  id="database-display"
                  value={databaseDraft.displayName}
                  onChange={(event) =>
                    setDatabaseDraft({ ...databaseDraft, displayName: event.target.value })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="database-description">Description</FieldLabel>
                <Textarea
                  id="database-description"
                  value={databaseDraft.description}
                  onChange={(event) =>
                    setDatabaseDraft({ ...databaseDraft, description: event.target.value })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="database-url">Base URL</FieldLabel>
                <Input
                  id="database-url"
                  value={databaseDraft.url}
                  onChange={(event) =>
                    setDatabaseDraft({ ...databaseDraft, url: event.target.value })
                  }
                />
              </Field>
              <Field data-invalid={validateDatabaseDraft(databaseDraft).method !== null || undefined}>
                <FieldLabel htmlFor="database-method">Method</FieldLabel>
                <Input
                  id="database-method"
                  value={databaseDraft.method}
                  onChange={(event) =>
                    setDatabaseDraft({ ...databaseDraft, method: event.target.value })
                  }
                  aria-invalid={validateDatabaseDraft(databaseDraft).method !== null || undefined}
                />
                {validateDatabaseDraft(databaseDraft).method && (
                  <FieldError>{validateDatabaseDraft(databaseDraft).method}</FieldError>
                )}
              </Field>
              <Field>
                <FieldLabel htmlFor="database-operation">Search operation</FieldLabel>
                <Input
                  id="database-operation"
                  value={databaseDraft.operation}
                  onChange={(event) =>
                    setDatabaseDraft({ ...databaseDraft, operation: event.target.value })
                  }
                />
              </Field>
              <Field data-invalid={validateDatabaseDraft(databaseDraft).query !== null || undefined}>
                <FieldLabel htmlFor="database-query">Query template</FieldLabel>
                <Textarea
                  id="database-query"
                  value={databaseDraft.query}
                  onChange={(event) =>
                    setDatabaseDraft({ ...databaseDraft, query: event.target.value })
                  }
                  aria-invalid={validateDatabaseDraft(databaseDraft).query !== null || undefined}
                />
                {validateDatabaseDraft(databaseDraft).query && (
                  <FieldError>{validateDatabaseDraft(databaseDraft).query}</FieldError>
                )}
              </Field>
              <Field data-invalid={validateDatabaseDraft(databaseDraft).headers !== null || undefined}>
                <FieldLabel htmlFor="database-headers">Headers template</FieldLabel>
                <Textarea
                  id="database-headers"
                  value={databaseDraft.headers}
                  onChange={(event) =>
                    setDatabaseDraft({ ...databaseDraft, headers: event.target.value })
                  }
                  aria-invalid={validateDatabaseDraft(databaseDraft).headers !== null || undefined}
                />
                {validateDatabaseDraft(databaseDraft).headers && (
                  <FieldError>{validateDatabaseDraft(databaseDraft).headers}</FieldError>
                )}
              </Field>
              <Field data-invalid={validateDatabaseDraft(databaseDraft).body !== null || undefined}>
                <FieldLabel htmlFor="database-body">Body template</FieldLabel>
                <Textarea
                  id="database-body"
                  value={databaseDraft.body}
                  onChange={(event) =>
                    setDatabaseDraft({ ...databaseDraft, body: event.target.value })
                  }
                  aria-invalid={validateDatabaseDraft(databaseDraft).body !== null || undefined}
                />
                {validateDatabaseDraft(databaseDraft).body && (
                  <FieldError>{validateDatabaseDraft(databaseDraft).body}</FieldError>
                )}
              </Field>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDatabaseDraft(null)}>
                  取消
                </Button>
                <Button
                  disabled={hasDatabaseErrors(validateDatabaseDraft(databaseDraft))}
                  onClick={() => void saveDatabase()}
                >
                  保存数据库
                </Button>
              </DialogFooter>
            </FieldGroup>
          )}
        </DialogContent>
      </Dialog>

      {/* ---- Delete confirmation dialog ---- */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              删除“{pendingDelete?.label}”后无法恢复。内置数据库不会提供删除操作。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}
