import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowClockwiseIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  StarIcon,
} from "@phosphor-icons/react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ModelDetailDialog } from "@/components/settings/model/ModelDetailDialog";
import { ModelImportSheet } from "@/components/settings/model/ModelImportSheet";
import type {
  ManagedModelInfo,
  ModelSettings,
  ProviderInfo,
  SettingsAPIClient,
} from "@/hooks/useAPI";
import { formatContextWindow } from "@/lib/tokenFormat";

interface ModelListManagerProps {
  api: SettingsAPIClient;
  providers: ProviderInfo[];
  managedModels: ManagedModelInfo[];
  activeModelName: string | null;
  onActivated: (settings: ModelSettings) => void;
  onChanged: () => void;
}

const MODEL_PAGE_SIZE = 8;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败";
}

/** 来源标签：手动添加，或元数据被用户改过（与默认值不再一致）时显示“手动配置”，否则显示供应商名称。 */
function sourceBadgeLabel(model: ManagedModelInfo): string {
  return model.source === "manual" || model.metadata_source === "user"
    ? "手动配置"
    : model.provider_name;
}

export function ModelListManager({
  api,
  providers,
  managedModels,
  activeModelName,
  onActivated,
  onChanged,
}: ModelListManagerProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [detailModel, setDetailModel] = useState<ManagedModelInfo | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageModels, setPageModels] = useState<ManagedModelInfo[]>([]);
  const [pageTotal, setPageTotal] = useState(0);
  const [pageLoading, setPageLoading] = useState(true);
  // 新增模型后置位：列表加载完成后跳到最后一页（新模型按插入顺序追加在末尾）
  const revealNewModelRef = useRef(false);
  // 请求序号：丢弃乱序返回的过期响应，避免旧数据覆盖新数据
  const fetchSeqRef = useRef(0);

  const loadPage = useCallback(async () => {
    const seq = ++fetchSeqRef.current;
    setPageLoading(true);
    try {
      const q = search.trim();
      const result = await api.fetchManagedModelsPage({
        page,
        size: MODEL_PAGE_SIZE,
        q: q === "" ? undefined : q,
      });
      if (seq !== fetchSeqRef.current) return;
      setPageTotal(result.total);
      const totalPages = Math.max(1, Math.ceil(result.total / MODEL_PAGE_SIZE));
      if (page > totalPages) {
        // 当前页越界（如删除末页仅剩的模型）时回退到实际最后一页，页码变化会触发自动重载
        revealNewModelRef.current = false;
        setPage(totalPages);
        return;
      }
      if (revealNewModelRef.current && page < totalPages) {
        // 新增模型追加在列表末尾：跳到最后一页确保立即可见，页码变化会触发自动重载
        revealNewModelRef.current = false;
        setPage(totalPages);
        return;
      }
      revealNewModelRef.current = false;
      setPageModels(result.items);
    } catch (error) {
      if (seq === fetchSeqRef.current) {
        toast.error("模型列表加载失败", { description: errorText(error) });
      }
    } finally {
      if (seq === fetchSeqRef.current) {
        setPageLoading(false);
      }
    }
  }, [api, page, search]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadPage();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadPage]);

  const totalPages = Math.max(1, Math.ceil(pageTotal / MODEL_PAGE_SIZE));

  /**
   * 添加/导入/编辑模型后刷新列表。
   * 新增的模型总是追加在列表末尾（后端按插入顺序返回），
   * 刷新后由 loadPage 自动跳到最后一页确保新模型立即可见。
   */
  const handleSaved = useCallback(
    (created?: ManagedModelInfo) => {
      onChanged();
      if (created) {
        revealNewModelRef.current = true;
      }
      void loadPage();
    },
    [onChanged, loadPage],
  );

  /** 手动刷新：同时刷新供应商/模型注册表与当前分页列表。 */
  const handleManualRefresh = useCallback(() => {
    revealNewModelRef.current = false;
    onChanged();
    void loadPage();
  }, [onChanged, loadPage]);

  const openAdd = () => {
    setSheetOpen(true);
  };

  const openDetail = (model: ManagedModelInfo) => {
    setDetailModel(model);
    setDetailOpen(true);
  };

  const activate = async (model: ManagedModelInfo) => {
    setActivatingId(model.id);
    try {
      const updated = await api.activateManagedModel(model.id);
      onActivated(updated);
      toast.success(`已切换当前模型为 ${model.name}`);
      onChanged();
      void loadPage();
    } catch (error) {
      toast.error("切换失败", { description: errorText(error) });
    } finally {
      setActivatingId(null);
    }
  };

  const remove = async (model: ManagedModelInfo) => {
    try {
      await api.deleteManagedModel(model.id);
      toast.success(`已移除 ${model.name}`);
      onChanged();
      void loadPage();
    } catch (error) {
      toast.error("移除失败", { description: errorText(error) });
    } finally {
      setConfirmDeleteId(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          维护各供应商下的模型：可从供应商返回的列表导入，也可手动添加。
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleManualRefresh}
            disabled={pageLoading}
            aria-label="刷新模型列表"
            title="刷新模型列表"
          >
            <ArrowClockwiseIcon
              className={cn("size-3.5", pageLoading && "animate-spin")}
              aria-hidden="true"
            />
          </Button>
          <Button
            size="sm"
            onClick={openAdd}
            disabled={providers.length === 0}
            title={providers.length === 0 ? "请先添加供应商" : undefined}
          >
            <PlusIcon data-icon="inline-start" />
            添加模型
          </Button>
        </div>
      </div>
      {providers.length === 0 && (
        <p className="text-xs text-muted-foreground">
          添加第一个供应商后即可添加模型。
        </p>
      )}

      <div className="relative">
        <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          placeholder="搜索模型名称或 ID"
          aria-label="搜索模型"
          className="pl-8"
        />
      </div>

      {pageLoading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Spinner />
        </div>
      ) : pageModels.length === 0 ? (
        <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          {search.trim() === ""
            ? "还没有维护的模型，点击“添加模型”开始。"
            : "没有找到匹配的模型。"}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {pageModels.map((model) => {
            const isActive = model.model_id === activeModelName;
            return (
              <li key={model.id} className="rounded-xl border bg-card px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{model.name}</span>
                      <Badge variant="outline" className="shrink-0">
                        {sourceBadgeLabel(model)}
                      </Badge>
                      {isActive && (
                        <Badge className="shrink-0 gap-1">
                          <StarIcon weight="fill" className="size-3" />
                          当前
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {model.provider_name} · {model.model_id} · 上下文{" "}
                      {formatContextWindow(model.context_window)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button variant="ghost" size="sm" onClick={() => openDetail(model)}>
                      详情
                    </Button>
                    <Button
                      variant={isActive ? "outline" : "default"}
                      size="sm"
                      disabled={isActive || activatingId === model.id}
                      onClick={() => void activate(model)}
                    >
                      {activatingId === model.id && <Spinner data-icon="inline-start" />}
                      {isActive ? "当前模型" : "设为当前"}
                    </Button>
                    {confirmDeleteId === model.id ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => void remove(model)}
                      >
                        确认删除
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => setConfirmDeleteId(model.id)}
                      >
                        删除
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!pageLoading && pageTotal > 0 && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">共 {pageTotal} 条</p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              上一页
            </Button>
            <span className="text-xs text-muted-foreground">
              第 {page} / {totalPages} 页
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            >
              下一页
            </Button>
          </div>
        </div>
      )}

      <ModelDetailDialog
        key={detailModel?.id ?? "closed"}
          open={detailOpen}
        onOpenChange={(next) => {
            setDetailOpen(next);
            if (!next) setDetailModel(null);
          }}
        model={detailModel}
        api={api}
        onSaved={handleSaved}
      />

      <ModelImportSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        api={api}
        providers={providers}
        managedModels={managedModels}
        onSaved={handleSaved}
      />
    </div>
  );
}