import { useEffect, useState } from "react";
import { toast } from "sonner";

import { DownloadSimpleIcon, TrashIcon } from "@phosphor-icons/react";

import {
  SettingCard,
  SettingRow,
  SettingSection,
} from "@/components/settings/primitives";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import type { CacheDatasetSummary } from "@/api/tasks";
import type { SettingsAPIClient } from "@/hooks/useAPI";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败";
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function GeneralSettingsSection({
  api,
  onExportCache,
}: {
  api: SettingsAPIClient;
  onExportCache: () => void;
}) {
  const [datasets, setDatasets] = useState<CacheDatasetSummary[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    datasetId: string;
    namespace: string;
  } | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try {
      const page = await api.fetchCacheDatasets();
      setDatasets(page.items);
    } catch (error) {
      toast.error("缓存列表加载失败", { description: errorText(error) });
    }
  };

  useEffect(() => {
    let cancelled = false;
    api
      .fetchCacheDatasets()
      .then((page) => {
        if (!cancelled) setDatasets(page.items);
      })
      .catch((error: unknown) => {
        if (!cancelled) toast.error("缓存列表加载失败", { description: errorText(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const deleteDataset = async () => {
    if (pendingDelete === null) return;
    const target = pendingDelete;
    setPendingDelete(null);
    setBusy(true);
    try {
      await api.deleteCacheDataset(target.datasetId, target.namespace);
      toast.success(`已删除缓存数据集 ${target.datasetId}`);
      await reload();
    } catch (error) {
      toast.error("删除失败", { description: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const clearCache = async () => {
    setClearConfirmOpen(false);
    setBusy(true);
    try {
      const deleted = await api.clearCacheDatasets();
      toast.success(`已清空本地缓存（${deleted} 个数据集）`);
      await reload();
    } catch (error) {
      toast.error("清空失败", { description: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <SettingSection
        title="本地数据"
        description="管理应用在本机保存的缓存数据。下载的原始数据与手动导入的文件会自动登记到本地缓存。"
      >
        <SettingCard>
          <SettingRow
            id="settings-export-cache"
            title="导出本地缓存"
            description="导出已登记的本地缓存数据集及其清单。"
            control={
              <Button variant="outline" onClick={onExportCache}>
                <DownloadSimpleIcon data-icon="inline-start" />
                导出缓存
              </Button>
            }
          />
          <SettingRow
            id="settings-clear-cache"
            title="清空本地缓存"
            description="删除全部已登记的缓存数据集（保留任务目录与导出文件）。"
            danger
            control={
              <Button
                variant="outline"
                disabled={busy || datasets === null || datasets.length === 0}
                onClick={() => setClearConfirmOpen(true)}
              >
                <TrashIcon data-icon="inline-start" />
                清空缓存
              </Button>
            }
          />
        </SettingCard>

        <SettingCard>
          <SettingRow
            id="settings-cache-list"
            title="已登记缓存数据集"
            description="运行期间下载并登记到本地缓存的原始数据与导入文件。"
            control={
              <Button variant="ghost" size="sm" onClick={() => void reload()} disabled={busy}>
                刷新
              </Button>
            }
          />
          {datasets === null ? (
            <div className="flex items-center justify-center gap-2 px-5 py-6 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              正在加载缓存列表…
            </div>
          ) : datasets.length === 0 ? (
            <Empty>
              <EmptyHeader>暂无缓存数据集</EmptyHeader>
              <EmptyDescription>
                下载或导入文件后，数据集会出现在这里供复用与管理。
              </EmptyDescription>
            </Empty>
          ) : (
            datasets.map((dataset) => (
              <SettingRow
                key={`${dataset.namespace}/${dataset.dataset_id}`}
                id={`cache-dataset-${dataset.dataset_id}`}
                title={dataset.dataset_id}
                description={`${dataset.namespace} · ${dataset.row_count} 行 · ${formatTime(dataset.published_at)}`}
                control={
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      setPendingDelete({
                        datasetId: dataset.dataset_id,
                        namespace: dataset.namespace,
                      })
                    }
                  >
                    <TrashIcon data-icon="inline-start" />
                    删除
                  </Button>
                }
                controlClassName="max-sm:w-full"
              />
            ))
          )}
        </SettingCard>
      </SettingSection>

      <SettingSection title="关于">
        <SettingCard>
          <SettingRow
            title="BioMed QAgent"
            description="面向生物医学检索与科研工作流的 Agent 控制台。"
            control={<Badge variant="outline">v1.0.0</Badge>}
          />
        </SettingCard>
      </SettingSection>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              删除缓存数据集“{pendingDelete?.datasetId}”（{pendingDelete?.namespace}）后无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void deleteDataset()}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={clearConfirmOpen} onOpenChange={setClearConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认清空</AlertDialogTitle>
            <AlertDialogDescription>
              将删除本地缓存中的全部已登记数据集，删除后无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void clearCache()}>清空</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}