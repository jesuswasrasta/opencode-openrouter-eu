import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { CACHE_FILE_NAME, GLOBAL_HOSTS } from "./constants"
import type { Config } from "./config"

export interface CatalogCache {
  baseURL: string
  fetchedAt: number
  ids: string[]
}

export type CatalogSource = "network" | "cache" | "cache-stale"

export interface CatalogResult {
  ids: Set<string>
  source: CatalogSource
  fetchedAt: number
}

export interface CatalogDeps {
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  cacheFile?: string
}

export function resolveCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const cacheHome = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache")
  return join(cacheHome, "opencode", CACHE_FILE_NAME)
}

/** True when the URL points at OpenRouter's global, region-agnostic endpoint. */
export function isGlobalEndpoint(baseURL: string): boolean {
  let host: string
  try {
    host = new URL(baseURL).hostname.toLowerCase()
  } catch {
    return false
  }
  return GLOBAL_HOSTS.includes(host)
}

export function modelsURL(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, "")}/models`
}

/** Extracts model IDs from an OpenRouter `/models` payload, tolerating junk. */
export function extractIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return []
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  const ids: string[] = []
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue
    const id = (entry as { id?: unknown }).id
    if (typeof id === "string" && id.trim()) ids.push(id.trim())
  }
  return ids
}

/** Fetches the regional catalog, retrying once on any failure. */
export async function fetchCatalogIds(
  baseURL: string,
  timeoutMs: number,
  deps: CatalogDeps = {},
): Promise<string[]> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let lastError: unknown

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(modelsURL(baseURL), { signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const ids = extractIds(await response.json())
      if (ids.length === 0) throw new Error("catalog listed no models")
      return ids
    } catch (error) {
      lastError = error
      if (attempt === 0) await sleep(250)
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export async function readCache(cacheFile: string): Promise<CatalogCache | undefined> {
  try {
    const raw = JSON.parse(await readFile(cacheFile, "utf8")) as Partial<CatalogCache>
    if (typeof raw.baseURL !== "string" || typeof raw.fetchedAt !== "number") return undefined
    if (!Array.isArray(raw.ids)) return undefined
    const ids = raw.ids.filter((id): id is string => typeof id === "string" && id !== "")
    if (ids.length === 0) return undefined
    return { baseURL: raw.baseURL, fetchedAt: raw.fetchedAt, ids }
  } catch {
    return undefined
  }
}

export async function writeCache(cacheFile: string, cache: CatalogCache): Promise<void> {
  try {
    await mkdir(dirname(cacheFile), { recursive: true })
    await writeFile(cacheFile, `${JSON.stringify(cache)}\n`, { mode: 0o600 })
  } catch {
    // best effort: a read-only cache directory must not break the plugin
  }
}

export interface LoadCatalogOptions extends CatalogDeps {
  baseURL: string
}

/**
 * Returns the regional catalog, preferring a fresh cache, then the network, then
 * a stale cache. Throws only when no catalog is available at all, so the caller
 * can apply its own fail-open / fail-closed policy.
 */
export async function loadCatalog(config: Config, options: LoadCatalogOptions): Promise<CatalogResult> {
  const now = options.now ?? Date.now
  const cacheFile = options.cacheFile ?? resolveCachePath()
  const ttlMs = config.ttlHours * 60 * 60 * 1000
  const cached = await readCache(cacheFile)
  const matchingCache = cached && cached.baseURL === options.baseURL ? cached : undefined

  if (matchingCache && now() - matchingCache.fetchedAt < ttlMs) {
    return { ids: new Set(matchingCache.ids), source: "cache", fetchedAt: matchingCache.fetchedAt }
  }

  try {
    const ids = await fetchCatalogIds(options.baseURL, config.timeoutMs, options)
    const fetchedAt = now()
    await writeCache(cacheFile, { baseURL: options.baseURL, fetchedAt, ids })
    return { ids: new Set(ids), source: "network", fetchedAt }
  } catch (error) {
    if (matchingCache) {
      return { ids: new Set(matchingCache.ids), source: "cache-stale", fetchedAt: matchingCache.fetchedAt }
    }
    throw error
  }
}
