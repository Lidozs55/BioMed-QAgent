/**
 * Business tool bundle (P5-02 → P5-12).
 *
 * `createBusinessToolBundle` is the single assembly point for the curated
 * BioMed business tools registered into formal Pi sessions. Tool names must
 * match SKILL_TOOL_MAP (curated) exactly; duplicates fail closed (registry
 * guard). The caller (runtime composition) supplies the shared services —
 * network client, content cache, DB bridge client, browser pool/crawler,
 * approval gate and secrets — so business modules never construct their own
 * infrastructure or import Pi types.
 *
 * P5-12 registration rule:
 *
 * ```text
 * registered curated tool names
 * == SKILL_TOOL_NAMES
 *    - explicitly unavailable tools (capability gates)
 *    + enabled dynamic user tools (declarative database operations)
 * ```
 */

import { PublicHttpClient } from "../../external/network/http-client.js";
import { ContentCache } from "../../external/acquisition/content-cache.js";
import type { BrowserFallback } from "../../external/sources/fallback.js";
import type { CrawlerFacade } from "../../external/crawler/crawler.js";
import type { DatabaseClient } from "../../persistence/db-client.js";
import type { BioMedAgentTool } from "../contracts.js";
import { assertUniqueToolNames } from "./registry.js";
import { createAnalyzePapersTool, type AnalyzePapersHooks } from "./literature-understanding.js";
import { createResearchDataGuidanceTool } from "./guidance.js";
import { createPubmedTools } from "./pubmed.js";
import { createGeoTools } from "./geo.js";
import { createGdcTools } from "./gdc.js";
import { createXenaTools } from "./xena.js";
import { createChemblTools } from "./chembl.js";
import { createUniprotTools } from "./uniprot.js";
import { createPdbTools } from "./pdb.js";
import { createPubchemTools } from "./pubchem.js";
import { createReactomeTools } from "./reactome.js";
import { createLocalCacheTools } from "./local-cache.js";
import { createPdfTools } from "./pdf.js";
import { createChartDataVlmTool } from "./extract-chart-data-vlm.js";
import type { VlmConfig } from "../../processing/vlm/vlm-client.js";
import type { QueryStatus, ToolApprovalGate, ToolHooks, ToolServiceDeps } from "./tool-hooks.js";

export interface BusinessToolBundleContext {
  /** Absolute task root (TaskWorkDir root). */
  taskRoot: string;
  hooks?: ToolHooks;
  guidanceDocsRoot?: string;
  /** DB bridge client (local cache + declarative database tools). */
  db?: DatabaseClient | null;
  /** Durable credential approval gate (declarative credentialed ops). */
  approvalGate?: ToolApprovalGate | null;
  /** Server-side secrets (BIOMED_SKILL_SECRET_*), never sent to the model. */
  secrets?: Readonly<Record<string, string>>;
  /** Browser capability services; when absent, browser-dependent tools are
   * excluded (explicitly unavailable) instead of degrading silently. */
  browser?: {
    crawler: CrawlerFacade;
    cache: ContentCache;
    client: PublicHttpClient;
    fallback: BrowserFallback;
  } | null;
  /** VLM model config for chart extraction (defaults to env config). */
  vlmConfig?: Partial<VlmConfig>;
  /** Warning surface (Python run_ctx.add_warning parity). */
  onWarning?: (severity: string, message: string, source: string) => void;
  /** Curated capability gates (product-disabled tools); default: all enabled. */
  disabledTools?: ReadonlySet<string>;
}

export interface BusinessToolBundle {
  readonly tools: readonly BioMedAgentTool[];
  readonly ownerOf: (toolName: string) => string | undefined;
  /** Curated tools skipped because their capability was unavailable. */
  readonly unavailableTools: ReadonlySet<string>;
}

export async function createBusinessToolBundle(
  context: BusinessToolBundleContext,
): Promise<BusinessToolBundle> {
  const { taskRoot } = context;
  const shared: ToolServiceDeps = { taskRoot, hooks: context.hooks };
  const client = context.browser?.client ?? new PublicHttpClient();
  const cache = context.browser?.cache ?? new ContentCache(`${taskRoot}/cache`);
  const disabled = context.disabledTools ?? new Set<string>();
  const geoEutils = { email: "biomed-agent@example.com", tool: "biomed-qagent", userAgent: "BioMed-QAgent/1.0" };
  const tools: BioMedAgentTool[] = [];
  const unavailable = new Set<string>();
  const ownerOf = new Map<string, string>();

  const register = (list: readonly BioMedAgentTool[], owner: string): void => {
    for (const tool of list) {
      if (disabled.has(tool.name)) {
        unavailable.add(tool.name);
        continue;
      }
      tools.push(tool);
      ownerOf.set(tool.name, owner);
    }
  };

  // Deterministic, network-free tools.
  const analyzeHooks = context.hooks?.onQuery === undefined ? {} : {
    onQuery: (query: string, source: string, status: string, recordsCount: number) => {
      context.hooks?.onQuery?.(query, source, status as QueryStatus, recordsCount);
    },
  };
  register([createAnalyzePapersTool(analyzeHooks)], "literature_understanding");
  register([createResearchDataGuidanceTool({ docsRoot: context.guidanceDocsRoot })], "research_data_guidance");

  // Curated external data sources (P5-03..P5-06).
  register(createPubmedTools(shared), "pubmed");
  register(createGeoTools({ taskRoot, cache, client, hooks: context.hooks, eutils: geoEutils }), "geo");
  register(createGdcTools({ ...shared, client, cache }), "gdc");
  register(createXenaTools({ ...shared, client, cache }), "xena");
  register(createChemblTools({
    ...shared,
    client,
    browserFallback: context.browser?.fallback,
  }), "chembl");
  register(createUniprotTools({
    ...shared,
    client,
    browserFallback: context.browser?.fallback,
  }), "uniprot");
  register(createPdbTools({ ...shared, client }), "pdb");
  register(createPubchemTools({
    ...shared,
    client,
    browserFallback: context.browser?.fallback,
  }), "pubchem");
  register(createReactomeTools({
    ...shared,
    client,
    browserFallback: context.browser?.fallback,
  }), "reactome");

  // Browser/crawler/visual capture (P5-07): excluded when the pool is absent.
  if (context.browser !== null && context.browser !== undefined) {
    const { createBrowserTools } = await import("./browser.js");
    const { createWebVisualCaptureTools } = await import("./web-visual-capture.js");
    const browserTools = createBrowserTools({
      taskRoot,
      cache,
      client,
      crawler: context.browser.crawler,
      hooks: context.hooks,
    });
    register([browserTools.navigatePage, browserTools.downloadFromPage], "browser_fallback");
    const captureTools = createWebVisualCaptureTools({
      taskRoot,
      crawler: context.browser.crawler,
      hooks: context.hooks,
    });
    register([captureTools.captureWebPage, captureTools.capturePageSection], "web_visual_capture");
  } else {
    unavailable.add("navigate_page");
    unavailable.add("download_from_page");
    unavailable.add("capture_web_page");
    unavailable.add("capture_page_section");
  }

  // Local cache (P5-10): the DB bridge is the only sanctioned path.
  if (context.db !== null && context.db !== undefined) {
    register(createLocalCacheTools({ db: context.db, hooks: context.hooks }), "local_cache");
  } else {
    unavailable.add("search_local_cache");
    unavailable.add("describe_local_cache");
    unavailable.add("get_cache_dataset");
  }

  // PDF + VLM processing (P5-08).
  register(createPdfTools(shared), "pdf_extraction");
  register(createChartDataVlmTool({
    ...shared,
    vlmConfig: context.vlmConfig,
    onWarning: context.onWarning,
  }), "extract_chart_data_vlm");

  // Analysis tools (P5-09) are appended by the caller alongside the
  // DatasetBuild tools until the analysis module lands; keep the
  // registration rule honest by marking them unavailable meanwhile.
  for (const name of [
    "run_differential_expression",
    "generate_heatmap",
    "basic_statistics",
    "generate_correlation_matrix",
  ]) {
    if (!tools.some((tool) => tool.name === name)) unavailable.add(name);
  }
  // User declarative database tools (P5-11) are appended by the caller with
  // the same registry guard because their names are dynamic.

  assertUniqueToolNames(tools);
  return {
    tools: Object.freeze(tools),
    ownerOf: (name) => ownerOf.get(name),
    unavailableTools: unavailable,
  };
}

export type { AnalyzePapersHooks };
