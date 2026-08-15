import { useEffect, useState } from "react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchPreviewText, parseCSV } from "@/lib/csvUtils";

/** CSV/TSV/TXT preview rendered inside artifact cards (legacy + V2 builds). */
export function CsvPreview({
  artifactUrl,
  noDataMessage,
  maxRows = 100,
}: {
  artifactUrl: string;
  noDataMessage?: string;
  maxRows?: number;
}) {
  const [state, setState] = useState<{
    url: string;
    data: ReturnType<typeof parseCSV> | null;
    error: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPreviewText(artifactUrl)
      .then((text) => {
        if (!cancelled) setState({ url: artifactUrl, data: parseCSV(text), error: false });
      })
      .catch(() => {
        if (!cancelled) setState({ url: artifactUrl, data: null, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [artifactUrl]);

  if (state?.url !== artifactUrl) {
    return (
      <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
        <Spinner />
        加载中...
      </div>
    );
  }
  if (state.error) {
    return <Empty className="border-0 py-4"><EmptyHeader><EmptyTitle>无法加载 CSV 数据</EmptyTitle></EmptyHeader></Empty>;
  }
  if (state.data === null || state.data.headers.length === 0 || state.data.rows.length === 0) {
    const headerNote =
      state.data !== null && state.data.headers.length > 0
        ? `仅含表头：${state.data.headers.join("、")}`
        : undefined;
    return (
      <Empty className="border-0 py-4">
        <EmptyHeader>
          <EmptyTitle>{noDataMessage ?? "无数据"}</EmptyTitle>
          {headerNote !== undefined && (
            <EmptyDescription>{headerNote}</EmptyDescription>
          )}
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="max-w-full overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {state.data.headers.map((header, index) => (
              <TableHead key={`${header}-${index}`} className="whitespace-nowrap text-xs">
                {header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
            {state.data.rows.slice(0, maxRows).map((row, rowIndex) => (
            <TableRow key={`row-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <TableCell key={`${rowIndex}-${cellIndex}`} className="whitespace-nowrap text-xs">
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {(state.data.truncated || state.data.rows.length > maxRows) && (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          仅显示前 {maxRows} 行
        </p>
      )}
    </div>
  );
}