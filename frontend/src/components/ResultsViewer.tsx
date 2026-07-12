import { useAgentStore } from "@/stores/agentStore";
import { useAPI } from "@/hooks/useAPI";
import { useState, useEffect } from "react";
import {
  FileTextIcon,
  FileJsonIcon,
  FileArchiveIcon,
  DownloadIcon,
  DatabaseIcon,
  FileQuestionIcon,
} from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";


/** Format bytes to human-readable size */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Get file extension from filename */
function getExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx === -1) return "";
  return name.slice(idx + 1).toLowerCase();
}

/** Choose icon and label based on file extension */
function getFileTypeInfo(name: string) {
  const ext = getExtension(name);
  switch (ext) {
    case "csv":
    case "txt":
    case "md":
    case "tsv":
      return { Icon: FileTextIcon, label: ext.toUpperCase() };
    case "json":
    case "jsonl":
      return { Icon: FileJsonIcon, label: ext.toUpperCase() };
    default:
      if (ext) return { Icon: FileQuestionIcon, label: ext.toUpperCase() };
      return { Icon: FileArchiveIcon, label: "FILE" };
  }
}

/** Determine if a filename looks like a CSV/spreadsheet */
function isCSV(filename: string): boolean {
  const ext = getExtension(filename);
  return ext === "csv";
}

/** Simple CSV parser — split by newlines, then by commas */
function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = lines.slice(1).map((line) => line.split(",").map((c) => c.trim()));
  return { headers, rows };
}

/** Parse traces to extract source provenance data */
let _sourceId = 0;

interface SourceEntry {
  id: number;
  tool: string;
  summary: string;
  details: string;
}

function parseSourceManifest(
  traces: { kind: string; name?: string; output?: string }[],
): SourceEntry[] {
  const entries: SourceEntry[] = [];

  for (let i = 0; i < traces.length; i++) {
    const item = traces[i];

    // Find tool_output entries preceded by a search_literature tool_call
    if (item.kind !== "tool_output" || !item.output) continue;

    const prevItem = i > 0 ? traces[i - 1] : null;
    const toolName =
      prevItem?.kind === "tool_call" ? prevItem.name : item.name;

    if (toolName?.toLowerCase().includes("search") !== true) continue;

    try {
      const parsed = JSON.parse(item.output);

      // Try to extract database-related fields
      if (parsed.databases && Array.isArray(parsed.databases)) {
        entries.push({
          id: ++_sourceId,
          tool: toolName,
          summary: `${parsed.databases.length} 个数据库`,
          details: parsed.databases.join("、"),
        });
      } else if (parsed.count !== undefined) {
        entries.push({
          id: ++_sourceId,
          tool: toolName,
          summary: `${parsed.count} 条记录`,
          details: JSON.stringify(parsed.results ?? parsed).slice(0, 200),
        });
      } else if (parsed.results !== undefined) {
        const len = Array.isArray(parsed.results)
          ? parsed.results.length
          : "?";
        entries.push({
          id: ++_sourceId,
          tool: toolName,
          summary: `${len} 条结果`,
          details: JSON.stringify(parsed.results).slice(0, 200),
        });
      } else {
        entries.push({
          id: ++_sourceId,
          tool: toolName,
          summary: "来源信息已获取",
          details: item.output.slice(0, 200),
        });
      }
    } catch {
      // Fallback: show raw output truncated
      entries.push({
        id: ++_sourceId,
        tool: toolName,
        summary: "来源信息已获取",
        details: item.output.slice(0, 200),
      });
    }
  }

  return entries;
}

/** Trigger file download by creating a hidden anchor */
function triggerDownload(url: string, filename: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/** Inline CSV preview component — fetches and renders CSV data */
function CsvPreview({
  artifactUrl,
}: {
  artifactUrl: string;
}) {
  const [csvData, setCsvData] = useState<{
    headers: string[];
    rows: string[][];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);

    fetch(artifactUrl)
      .then((res) => {
        if (!res.ok) throw new Error("fetch failed");
        return res.text();
      })
      .then((text) => {
        if (!cancelled) {
          setCsvData(parseCSV(text));
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [artifactUrl]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
        <Spinner />
        加载中...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 py-4 text-center text-sm text-muted-foreground">
        <FileTextIcon className="size-6 opacity-30" />
        <span>无法加载 CSV 数据</span>
      </div>
    );
  }

  if (!csvData || csvData.headers.length === 0) {
    return (
      <div className="py-4 text-center text-sm text-muted-foreground">
        无数据
      </div>
    );
  }

  const displayRows = csvData.rows.slice(0, 100);

  return (
    <div className="max-h-64 overflow-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {csvData.headers.map((header, idx) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: CSV headers have no IDs
              <TableHead key={idx} className="text-xs">
                {header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {displayRows.map((row, rowIdx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: CSV rows have no IDs
            <TableRow key={rowIdx}>
              {row.map((cell, cellIdx) => (
                <TableCell
                  // biome-ignore lint/suspicious/noArrayIndexKey: CSV cells have no IDs
                  key={`${rowIdx}-${cellIdx}`}
                  className="text-xs"
                >
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {csvData.rows.length > 100 && (
        <div className="px-2 py-1 text-xs text-muted-foreground">
          仅显示前 100 行（共 {csvData.rows.length} 行）
        </div>
      )}
    </div>
  );
}

export default function ResultsViewer() {
  const artifacts = useAgentStore((s) => s.artifacts);
  const taskId = useAgentStore((s) => s.taskId);
  const isRunning = useAgentStore((s) => s.isRunning);
  const traces = useAgentStore((s) => s.traces);

  const { getArtifactUrl } = useAPI();

  const sourceData = parseSourceManifest(traces);

  // ── Loading state ──────────────────────────────────────────
  if (isRunning && artifacts.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <Spinner />
          处理中...
        </div>
      </div>
    );
  }

  // ── Empty state ────────────────────────────────────────────
  if (artifacts.length === 0 && !isRunning) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-muted-foreground">
          <FileTextIcon className="size-8 opacity-30" />
          <span>暂无结果</span>
        </div>
      </div>
    );
  }

  // ── Main content ───────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4">
      {/* Source Manifest Accordion */}
      {sourceData.length > 0 && (
        <Accordion>
          <AccordionItem value="source-manifest">
            <AccordionTrigger>
              <DatabaseIcon className="size-4" />
              数据来源
            </AccordionTrigger>
            <AccordionContent>
              <div className="flex flex-col gap-2">
                {sourceData.map((entry) => (
                  <Card key={entry.id} size="sm">
                    <CardHeader>
                      <CardTitle className="text-xs font-mono">
                        {entry.tool}
                      </CardTitle>
                      <CardDescription>{entry.summary}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <pre className="whitespace-pre-wrap break-all font-mono text-[0.625rem] leading-relaxed text-muted-foreground">
                        {entry.details}
                      </pre>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}

      {/* Artifact Cards */}
      <ScrollArea className="h-full">
        <div className="flex flex-col gap-3">
          {artifacts.map((artifact) => {
            const { Icon, label } = getFileTypeInfo(artifact.name);
            const isCsvFile = isCSV(artifact.name);

            return (
              <Card key={artifact.name} size="sm">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <CardTitle className="truncate">{artifact.name}</CardTitle>
                    <Badge variant="outline">{label}</Badge>
                  </div>
                  <CardDescription>
                    {formatSize(artifact.size)}
                  </CardDescription>
                </CardHeader>

                {/* CSV Preview Section — real inline table */}
                {isCsvFile && (
                  <CardContent>
                    <Accordion>
                      <AccordionItem value={`csv-preview-${artifact.name}`}>
                        <AccordionTrigger>
                          CSV 预览
                        </AccordionTrigger>
                        <AccordionContent>
                          <CsvPreview
                            artifactUrl={getArtifactUrl(
                              taskId ?? "",
                              artifact.name,
                            )}
                          />
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  </CardContent>
                )}

                <CardFooter className="border-t pt-(--card-spacing)">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      triggerDownload(
                        getArtifactUrl(taskId ?? "", artifact.name),
                        artifact.name,
                      )
                    }
                  >
                    <DownloadIcon
                      data-icon="inline-start"
                      className="size-3"
                    />
                    下载
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
