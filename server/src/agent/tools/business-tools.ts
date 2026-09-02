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

import {
  DEFAULT_RUNTIME_LIMITS,
  modelRetryPolicyFromRuntimeLimits,
  type RuntimeLimits,
} from "@biomed/contracts";

import { defaultNcbiClientConfig } from "../../external/ncbi/client.js";
import { HostRateLimiter } from "../../external/ncbi/retry.js";
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
import { createDbsnpTools } from "./dbsnp.js";
import { createOpenFdaTools } from "./openfda.js";
import { createClinvarTools } from "./clinvar.js";
import { createMgnifyTools } from "./mgnify.js";
import { createGwasCatalogTools } from "./gwas-catalog.js";
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
import { createRegisteredPaperChartEvidenceTool } from "./extract-registered-paper-chart-evidence.js";
import type { VlmConfig } from "../../processing/vlm/vlm-client.js";
import type { ToolApprovalGate, ToolHooks, ToolServiceDeps } from "./tool-hooks.js";
import type { DatasetHILGate } from "../../dataset/review/hil-policy.js";
import { BrowserAcquisitionEvidenceStore } from "../../runtime/browser-acquisition-store.js";
import { BrowserAcquisitionProposalStore } from "../../runtime/browser-acquisition-proposal-store.js";
import { BrowserFormalizationService } from "../../dataset/acquisition/browser-formalization.js";
import { BrowserParserRecipeRegistry, createDefaultBrowserParserRecipeRegistry } from "../../dataset/acquisition/browser-recipe-registry.js";
import type { SourceAssetRegistry } from "../../runtime/source-assets/registry.js";

export interface BusinessToolBundleContext {
  /** Absolute task root (TaskWorkDir root). */
  taskRoot: string;
  /** Agent-owned preparation root for readable processing outputs. */
  workspaceRoot?: string;
  hooks?: ToolHooks;
  /** Per-run analysis staging key; may be a live getter for later runs. */
  runId?: string | (() => string);
  guidanceDocsRoot?: string;
  /** DB bridge client (local cache + declarative database tools). */
  db?: DatabaseClient | null;
  /** Durable credential approval gate (declarative credentialed ops). */
  approvalGate?: ToolApprovalGate | null;
  /** Durable semantic/data review primitive used by Dataset and VLM policy. */
  hilGate?: DatasetHILGate | null;
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
  /** Fixed VLM configuration for fixture/test bundles. Production prefers resolveVlmConfig. */
  vlmConfig?: VlmConfig;
  /** VLM config resolver, consulted per extraction call so settings changes
   * apply without restart; resolved keys stay in memory only. */
  resolveVlmConfig?: () => Promise<VlmConfig>;
  /** Optional dedicated transport for governed visual-model calls (evaluation
   * harnesses inject a fixture transport; default is the shared client). */
  vlmHttpClient?: PublicHttpClient;
  /** Operational budgets snapshotted for this run. */
  limits?: RuntimeLimits;
  /** Warning surface (Python run_ctx.add_warning parity). */
  onWarning?: (severity: string, message: string, source: string) => void;
  /** Curated capability gates (product-disabled tools); default: all enabled. */
  disabledTools?: ReadonlySet<string>;
  /** Global cache registrar: registers raw downloads into the dataset cache. */
  registrar?: import("../../persistence/cache-registrar.js").CacheRegistrar | null;
  sourceAssetRegistry?: SourceAssetRegistry;
  browserRecipeRegistry?: BrowserParserRecipeRegistry;
  /** Task id used as cache provenance (``created_by_task_id``). */
  taskId?: string | (() => string);
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
  const shared: ToolServiceDeps = {
    taskRoot,
    hooks: context.hooks,
    registrar: context.registrar,
    taskId: context.taskId,
  };
  const sourceAssetRegistry = context.sourceAssetRegistry ?? null;
  const limits = context.limits ?? DEFAULT_RUNTIME_LIMITS;
  const client = context.browser?.client ?? new PublicHttpClient({ timeoutMs: limits.http_timeout_seconds * 1000 });
  const cache = context.browser?.cache ?? new ContentCache(`${taskRoot}/cache`);
  const disabled = context.disabledTools ?? new Set<string>();
  // NCBI contact identity is env-driven (NCBI_EMAIL/NCBI_TOOL/...) so each
  // deployment sends a real contact address; previously the GEO eutils client
  // hardcoded a divergent identity that ignored NCBI_EMAIL (audit P0-11).
  const ncbiIdentity = defaultNcbiClientConfig();
  const geoEutils = {
    email: ncbiIdentity.email,
    tool: ncbiIdentity.tool,
    userAgent: ncbiIdentity.userAgent,
    apiKey: ncbiIdentity.apiKey ?? null,
    totalTimeoutMs: limits.http_timeout_seconds * 1000,
  };
  // dbSNP/ClinVar/openFDA/GWAS Catalog pace through private process-wide
  // limiters; hand each tool a settings-paced limiter so the user's
  // request_interval_ms applies here too (audit P0-4/P0-11 sibling wiring).
  const ncbiToolPacing = () => new HostRateLimiter({
    minInterval: limits.request_interval_ms / 1000,
  });
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
  register([createAnalyzePapersTool(context.hooks ?? {})], "literature_understanding");
  register([createResearchDataGuidanceTool({ docsRoot: context.guidanceDocsRoot })], "research_data_guidance");
  // This task/run-scoped tool is injected by phase3-composition once the
  // authoritative SourceAssetRegistry and Dataset Core context exist.
  unavailable.add("inspect_dataset_execution_routes");
  unavailable.add("scaffold_dataset_profile");
  unavailable.add("extract_supplementary_archive");
  unavailable.add("prepare_dynamic_family_publication");
  unavailable.add("submit_dynamic_family_publication");
  unavailable.add("scaffold_dataset_execution_spec");
  unavailable.add("preflight_cleaning_rules");
  unavailable.add("inspect_source_coverage");

  // Curated external data sources (P5-03..P5-06).
  register(createPubmedTools({
    ...shared,
    sourceAssetRegistry,
    http: client,
    maxDownloadBytes: limits.max_download_mib * 1024 * 1024,
    downloadTimeoutMs: limits.download_timeout_seconds * 1000,
    config: { totalTimeoutMs: limits.http_timeout_seconds * 1000 },
  }), "pubmed");
  const maxApiResponseBytes = limits.api_response_max_mib * 1024 * 1024;
  const modelRetryPolicy = modelRetryPolicyFromRuntimeLimits(limits);
  register(createDbsnpTools({
    client,
    limiter: ncbiToolPacing(),
    maxResponseBytes: maxApiResponseBytes,
  }), "dbsnp");
  register(createOpenFdaTools({
    client,
    limiter: ncbiToolPacing(),
    maxResponseBytes: maxApiResponseBytes,
  }), "openfda");
  register(createClinvarTools({
    client,
    limiter: ncbiToolPacing(),
    maxResponseBytes: maxApiResponseBytes,
  }), "clinvar");
  register(createMgnifyTools({ client, maxResponseBytes: maxApiResponseBytes }), "mgnify");
  register(createGwasCatalogTools({
    client,
    limiter: ncbiToolPacing(),
    maxResponseBytes: maxApiResponseBytes,
  }), "gwas_catalog");
  register(createGeoTools({
    taskRoot,
    cache,
    client,
    hooks: context.hooks,
    registrar: context.registrar,
    taskId: context.taskId,
    sourceAssetRegistry,
    eutils: geoEutils,
    maxDownloadBytes: limits.max_download_mib * 1024 * 1024,
    downloadTimeoutMs: limits.download_timeout_seconds * 1000,
  }), "geo");
  register(createGdcTools({
    ...shared,
    client,
    cache,
    maxDownloadBytes: limits.max_download_mib * 1024 * 1024,
    maxFiles: limits.gdc_max_files,
    downloadTimeoutMs: limits.download_timeout_seconds * 1000,
    rateLimitMs: limits.request_interval_ms,
  }), "gdc");
  register(createXenaTools({
    ...shared,
    client,
    cache,
    maxDownloadBytes: limits.max_download_mib * 1024 * 1024,
    downloadTimeoutMs: limits.download_timeout_seconds * 1000,
    rateLimitMs: limits.request_interval_ms,
  }), "xena");
  register(createChemblTools({
    ...shared,
    client,
    browserFallback: context.browser?.fallback,
    rateLimitMs: limits.request_interval_ms,
  }), "chembl");
  register(createUniprotTools({
    ...shared,
    client,
    browserFallback: context.browser?.fallback,
    rateLimitMs: limits.request_interval_ms,
  }), "uniprot");
  register(createPdbTools({
    ...shared,
    client,
    rateLimitMs: limits.request_interval_ms,
    maxDownloadBytes: limits.max_download_mib * 1024 * 1024,
    downloadTimeoutMs: limits.download_timeout_seconds * 1000,
  }), "pdb");
  register(createPubchemTools({
    ...shared,
    client,
    browserFallback: context.browser?.fallback,
    rateLimitMs: limits.request_interval_ms,
    maxDownloadBytes: limits.max_download_mib * 1024 * 1024,
    downloadTimeoutMs: limits.download_timeout_seconds * 1000,
  }), "pubchem");
  register(createReactomeTools({
    ...shared,
    client,
    browserFallback: context.browser?.fallback,
    rateLimitMs: limits.request_interval_ms,
    maxDownloadBytes: limits.max_download_mib * 1024 * 1024,
    downloadTimeoutMs: limits.download_timeout_seconds * 1000,
  }), "reactome");

  // Browser/crawler/visual capture (P5-07): excluded when the pool is absent.
  if (context.browser !== null && context.browser !== undefined) {
    const { createBrowserTools } = await import("./browser.js");
    const { createWebVisualCaptureTools } = await import("./web-visual-capture.js");
    const browserRecipeRegistry = context.browserRecipeRegistry ?? createDefaultBrowserParserRecipeRegistry();
    const browserTools = createBrowserTools({
      taskRoot,
      cache,
      client,
      crawler: context.browser.crawler,
      hooks: context.hooks,
      registrar: context.registrar,
      taskId: context.taskId,
      runId: context.runId,
      sourceAssetRegistry,
      evidenceStore: new BrowserAcquisitionEvidenceStore({ taskRoot }),
      proposalStore: new BrowserAcquisitionProposalStore(taskRoot),
      formalizationHIL: context.hilGate ?? undefined,
      formalizationService: context.sourceAssetRegistry === undefined
        ? undefined
        : new BrowserFormalizationService({
          evidenceStore: new BrowserAcquisitionEvidenceStore({ taskRoot }),
          proposalStore: new BrowserAcquisitionProposalStore(taskRoot),
          sourceAssetRegistry: context.sourceAssetRegistry,
          recipeRegistry: browserRecipeRegistry,
        }),
      recipeRegistry: browserRecipeRegistry,
      maxDownloadBytes: limits.max_download_mib * 1024 * 1024,
      downloadTimeoutMs: limits.download_timeout_seconds * 1000,
    });
    register([
      browserTools.navigatePage,
      browserTools.downloadFromPage,
      ...(context.hilGate === null || context.hilGate === undefined
        ? []
        : [browserTools.proposeFormalization]),
    ], "browser");
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
    register(createLocalCacheTools({
      db: context.db,
      hooks: context.hooks,
      timeoutMs: limits.database_timeout_seconds * 1000,
    }), "local_cache");
  } else {
    unavailable.add("search_local_cache");
    unavailable.add("describe_local_cache");
    unavailable.add("get_cache_dataset");
  }

  // PDF + VLM processing (P5-08).
  register(createPdfTools(shared), "pdf_extraction");
  register(createChartDataVlmTool({
    ...shared,
    workspaceRoot: context.workspaceRoot,
    vlmConfig: context.vlmConfig,
    resolveVlmConfig: context.resolveVlmConfig,
    httpClient: context.vlmHttpClient ?? client,
    modelRequestTimeoutMs: limits.model_request_timeout_seconds * 1000,
    modelRetryPolicy,
    pdfMaxPages: limits.vlm_pdf_max_pages,
    pdfMaxImages: limits.vlm_pdf_max_images,
    renderDpi: limits.vlm_render_dpi,
    onWarning: context.onWarning,
    hilGate: context.hilGate,
    approvalGate: context.approvalGate,
    sourceAssetRegistry: context.sourceAssetRegistry,
  }), "extract_chart_data_vlm");
  // Governed paper chart evidence (Gold6 T5): requires the task-owned
  // SourceAssetRegistry; without it the promotion path stays explicitly
  // unavailable instead of degrading to path-based inputs.
  if (context.sourceAssetRegistry !== undefined) {
    register(createRegisteredPaperChartEvidenceTool({
      ...shared,
      sourceAssetRegistry: context.sourceAssetRegistry,
      resolveVlmConfig: context.resolveVlmConfig,
      httpClient: context.vlmHttpClient ?? client,
      modelRequestTimeoutMs: limits.model_request_timeout_seconds * 1000,
      modelRetryPolicy,
      pdfMaxPages: limits.vlm_pdf_max_pages,
      renderDpi: limits.vlm_render_dpi,
      approvalGate: context.approvalGate,
      hilGate: context.hilGate,
    }), "extract_chart_data_vlm");
  } else {
    unavailable.add("extract_registered_paper_chart_evidence");
  }

  // Analysis tools (P5-09): Welch/BH/correlation/clustering with scipy
  // numeric parity; outputs confined to staging/analysis/<runId> (P5-D5).
  const { createAnalysisTools } = await import("./analysis.js");
  register(createAnalysisTools({
    taskRoot,
    hooks: context.hooks,
    runId: context.runId,
  }), "analysis");
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
