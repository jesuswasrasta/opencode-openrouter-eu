import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export type FailMode = "open" | "closed"

export interface Config {
  /** Provider whose model list gets filtered. */
  providerID: string
  /** Endpoint used to read the regional catalog. Defaults to the EU endpoint. */
  baseURL?: string
  /** How long a cached catalog stays valid. */
  ttlHours: number
  /** Timeout for a single catalog request. */
  timeoutMs: number
  /** Behaviour when no catalog is available: keep everything or drop everything. */
  onError: FailMode
  /** Model IDs that survive the filter even when the catalog does not list them. */
  allow: string[]
  /** Verbose logging. */
  debug: boolean
}

export const defaults: Config = {
  providerID: "openrouter",
  ttlHours: 6,
  timeoutMs: 4000,
  onError: "open",
  allow: [],
  debug: false,
}

export interface LoadedConfig {
  config: Config
  warnings: string[]
}

const KNOWN_KEYS = new Set([
  "providerID",
  "baseURL",
  "ttlHours",
  "timeoutMs",
  "onError",
  "allow",
  "debug",
])

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCODE_OPENROUTER_EU_CONFIG
  if (explicit && explicit.trim()) return explicit.trim()
  const configHome = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config")
  return join(configHome, "opencode", "openrouter-eu.json")
}

/** Normalizes an http(s) URL by validating it and stripping trailing slashes. */
export function normalizeBaseURL(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  return trimmed.replace(/\/+$/, "")
}

function positiveNumber(value: unknown, fallback: number, name: string, warnings: string[]): number {
  if (value === undefined) return fallback
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value
  warnings.push(`${name} must be a positive number, keeping ${fallback}`)
  return fallback
}

export function parseConfig(raw: unknown): LoadedConfig {
  const warnings: string[] = []

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { config: { ...defaults }, warnings: ["config must be a JSON object, using defaults"] }
  }

  const input = raw as Record<string, unknown>
  const config: Config = { ...defaults, allow: [] }

  if (input.providerID !== undefined) {
    if (typeof input.providerID === "string" && input.providerID.trim()) {
      config.providerID = input.providerID.trim()
    } else {
      warnings.push("providerID must be a non-empty string, keeping openrouter")
    }
  }

  if (input.baseURL !== undefined) {
    const value = normalizeBaseURL(input.baseURL)
    if (value) config.baseURL = value
    else warnings.push("baseURL must be an http(s) URL, ignoring it and using the provider setting")
  }

  config.ttlHours = positiveNumber(input.ttlHours, defaults.ttlHours, "ttlHours", warnings)
  config.timeoutMs = positiveNumber(input.timeoutMs, defaults.timeoutMs, "timeoutMs", warnings)

  if (input.onError !== undefined) {
    if (input.onError === "open" || input.onError === "closed") config.onError = input.onError
    else warnings.push('onError must be "open" or "closed", keeping open')
  }

  if (input.allow !== undefined) {
    if (Array.isArray(input.allow)) {
      const allow = input.allow.filter((id): id is string => typeof id === "string" && id.trim() !== "")
      if (allow.length !== input.allow.length) warnings.push("allow must only contain model IDs, dropping the rest")
      config.allow = allow.map((id) => id.trim())
    } else {
      warnings.push("allow must be an array of model IDs, ignoring it")
    }
  }

  if (input.debug !== undefined) {
    if (typeof input.debug === "boolean") config.debug = input.debug
    else warnings.push("debug must be a boolean, keeping false")
  }

  const unknown = Object.keys(input).filter((key) => !KNOWN_KEYS.has(key))
  if (unknown.length > 0) warnings.push(`ignoring unknown config keys: ${unknown.join(", ")}`)

  return { config, warnings }
}

export async function loadConfig(path: string = resolveConfigPath()): Promise<LoadedConfig> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { config: { ...defaults, allow: [] }, warnings: [] }
    return {
      config: { ...defaults, allow: [] },
      warnings: [`cannot read ${path} (${code ?? "unknown error"}), using defaults`],
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { config: { ...defaults, allow: [] }, warnings: [`${path} is not valid JSON, using defaults`] }
  }

  return parseConfig(parsed)
}
