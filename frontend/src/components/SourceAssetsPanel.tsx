import { useCallback, useEffect, useState } from "react";
import {
  FilesIcon,
  ShieldCheckIcon,
} from "@phosphor-icons/react";

import type { SourceAssetRegistrationReceipt } from "@/api/sourceAssets";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { useAPI } from "@/hooks/useAPI";
import { formatSize } from "@/lib/fileUtils";
import { errorMessage } from "@/lib/utils";

const ROLE_LABELS: Record<SourceAssetRegistrationReceipt["asset_ref"]["role"], string> = {
  source: "来源",
  mapping: "映射",
  metadata: "元数据",
  carrier: "载体",
};

export const SOURCE_ASSET_ROLE_LABELS = ROLE_LABELS;

interface SourceAssetsPanelProps {
  taskId: string;
}

/**
 * 只读的“来源/证据”登记列表。数据来自严格解析的
 * GET /api/v1/tasks/:id/source-assets；无上传、无任何变更操作，
 * 也不提供下载（listing API 本身不返回文件字节）。
 */
export default function SourceAssetsPanel({ taskId }: SourceAssetsPanelProps) {
  const api = useAPI();
  const [items, setItems] = useState<SourceAssetRegistrationReceipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    const fetchSourceAssets = api.fetchSourceAssets;
    if (fetchSourceAssets === undefined) {
      setLoading(false);
      setError("当前环境未提供来源/证据登记接口");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setItems(await fetchSourceAssets(taskId));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [api, taskId]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled) void loadItems();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [loadItems]);

  return (
    <section className="flex min-w-0 flex-col gap-3" aria-labelledby="source-assets-title">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id="source-assets-title" className="flex items-center gap-2 text-sm font-medium">
            <FilesIcon aria-hidden="true" />
            来源 / 证据登记
          </h3>
          <p className="text-sm text-muted-foreground">
            任务来源与证据资产的 Core 登记信息（只读清单）。
          </p>
        </div>
        <Badge variant="outline">
          <ShieldCheckIcon aria-hidden="true" />
          已登记 / 只读
        </Badge>
      </div>
      <div className="flex flex-col gap-3">
        {loading ? (
          <p className="text-sm text-muted-foreground">正在加载来源/证据登记…</p>
        ) : error !== null ? (
          <Alert variant="destructive">
            <AlertTitle>来源/证据登记加载失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : items.length === 0 ? (
          <Empty className="min-h-24 border-0 p-2">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FilesIcon aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>暂无来源/证据登记</EmptyTitle>
              <EmptyDescription>
                任务登记的来源与证据资产会显示在这里；此处为只读清单。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-3">
            {items.map((item) => (
              <Card key={item.receipt_id} size="sm">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="truncate" title={item.relative_path}>
                        {item.relative_path}
                      </CardTitle>
                      <CardDescription>
                        {item.media_type} · {formatSize(item.size_bytes)} ·{" "}
                        {new Date(item.registered_at).toLocaleString()}
                      </CardDescription>
                    </div>
                    <Badge variant="secondary">
                      {ROLE_LABELS[item.asset_ref.role]}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono break-all text-muted-foreground">
                      来源 ID：{item.source_id}
                    </span>
                  </div>
                  <dl className="grid gap-1 break-words text-muted-foreground md:grid-cols-2">
                    <div className="md:col-span-2">
                      <dt className="font-medium text-foreground">asset_id</dt>
                      <dd className="font-mono break-all">{item.asset_ref.asset_id}</dd>
                    </div>
                    <div className="md:col-span-2">
                      <dt className="font-medium text-foreground">sha256</dt>
                      <dd className="font-mono break-all">{item.sha256}</dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
