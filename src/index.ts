import { applyFilter } from "./apply"
import { isGlobalEndpoint, loadCatalog, type CatalogDeps, type CatalogResult } from "./catalog"
import { DEFAULT_EU_BASE_URL, PLUGIN_ID } from "./constants"
import { loadConfig, normalizeBaseURL, type Config } from "./config"
import { createLogger, type Logger } from "./log"
import type {
  OpenCodeModelEditor,
  OpenCodePluginContext,
  OpenCodeProviderRegistry,
} from "./types"

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Reads the effective endpoint of a provider from the V2 provider registry. */
export function providerBaseURL(
  registry: OpenCodeProviderRegistry | undefined,
  providerID: string,
): string | undefined {
  if (!registry || typeof registry.get !== "function") return undefined
  try {
    const entry = registry.get(providerID)
    return normalizeBaseURL(entry?.provider?.settings?.baseURL)
  } catch {
    return undefined
  }
}

/**
 * Single pass over the model registry. Exported so tests can drive it with a
 * fake editor and a fixed config, without booting OpenCode.
 */
export function filterModels(
  editor: OpenCodeModelEditor,
  config: Config,
  catalogBaseURL: string,
  catalog: CatalogResult | undefined,
  log: Logger,
): void {
  const liveBaseURL = providerBaseURL(editor.provider, config.providerID)
  const effectiveBaseURL = liveBaseURL ?? config.baseURL

  if (!effectiveBaseURL) {
    log.debug(`provider ${config.providerID} has no endpoint override, nothing to filter`)
    return
  }
  if (isGlobalEndpoint(effectiveBaseURL)) {
    log.debug(`provider ${config.providerID} uses the global endpoint, nothing to filter`)
    return
  }
  if (effectiveBaseURL !== catalogBaseURL) {
    log.warn(
      `provider ${config.providerID} points at ${effectiveBaseURL} but the catalog was read from ${catalogBaseURL}; ` +
        "set baseURL in the plugin config so they match",
    )
    return
  }

  const result = applyFilter(editor, {
    providerID: config.providerID,
    keep: catalog?.ids ?? new Set<string>(),
    allow: new Set(config.allow),
    catalogAvailable: catalog !== undefined,
    onError: config.onError,
  })

  if (result.errors.length > 0) {
    const sample = result.errors.slice(0, 5).join(", ")
    log.warn(`could not remove ${result.errors.length} model(s): ${sample}${result.errors.length > 5 ? ", ..." : ""}`)
  }
  if (result.skipped) {
    log.warn("no catalog available, keeping every model (onError=open)")
    return
  }
  log.info(`kept ${result.kept} model(s), removed ${result.removed.length}`)
}

export interface SetupOptions {
  /** Overrides the config file location, used by tests. */
  configPath?: string
  /** Overrides catalog dependencies, used by tests. */
  catalog?: CatalogDeps
}

export async function setup(ctx: OpenCodePluginContext, options: SetupOptions = {}): Promise<void> {
  const { config, warnings } = await loadConfig(options.configPath)
  const log = createLogger(config.debug)
  for (const warning of warnings) log.warn(warning)

  if (!ctx?.model || typeof ctx.model.transform !== "function") {
    log.warn("ctx.model.transform is not available, plugin disabled (OpenCode V2 is required)")
    return
  }

  const catalogBaseURL = config.baseURL ?? DEFAULT_EU_BASE_URL
  if (isGlobalEndpoint(catalogBaseURL)) {
    log.info(`endpoint ${catalogBaseURL} is OpenRouter global, nothing to filter`)
    return
  }

  let catalog: CatalogResult | undefined
  try {
    catalog = await loadCatalog(config, { ...options.catalog, baseURL: catalogBaseURL })
    log.debug(`catalog: ${catalog.ids.size} model(s) from ${catalog.source}`)
  } catch (error) {
    log.warn(`cannot load the regional catalog from ${catalogBaseURL}: ${describe(error)}`)
  }

  ctx.model.transform((editor) => {
    try {
      filterModels(editor, config, catalogBaseURL, catalog, log)
    } catch (error) {
      log.warn(`filtering failed: ${describe(error)}`)
    }
  })
}

export default { id: PLUGIN_ID, setup }
