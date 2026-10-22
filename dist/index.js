// src/apply.ts
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
function applyFilter(editor, options) {
  const result = { removed: [], kept: 0, skipped: false, errors: [] };
  if (!options.catalogAvailable && options.onError === "open") {
    result.skipped = true;
    return result;
  }
  let models;
  try {
    models = editor.list();
  } catch (error) {
    result.errors.push(`cannot list models: ${describe(error)}`);
    return result;
  }
  for (const model of models) {
    if (!model || model.providerID !== options.providerID)
      continue;
    const id = model.modelID ?? model.id;
    if (!id)
      continue;
    const keep = options.keep.has(id) || options.keep.has(model.id) || options.allow.has(id) || options.allow.has(model.id);
    if (keep) {
      result.kept += 1;
      continue;
    }
    try {
      editor.remove(options.providerID, id);
      result.removed.push(id);
    } catch (error) {
      result.errors.push(`${id}: ${describe(error)}`);
    }
  }
  return result;
}

// src/catalog.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// src/constants.ts
var PLUGIN_ID = "openrouter-eu";
var DEFAULT_EU_BASE_URL = "https://eu.openrouter.ai/api/v1";
var GLOBAL_HOSTS = ["openrouter.ai", "www.openrouter.ai"];
var CACHE_FILE_NAME = "openrouter-eu-models.json";
var LOG_PREFIX = `[${PLUGIN_ID}]`;

// src/catalog.ts
function resolveCachePath(env = process.env) {
  const cacheHome = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
  return join(cacheHome, "opencode", CACHE_FILE_NAME);
}
function isGlobalEndpoint(baseURL) {
  let host;
  try {
    host = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return false;
  }
  return GLOBAL_HOSTS.includes(host);
}
function modelsURL(baseURL) {
  return `${baseURL.replace(/\/+$/, "")}/models`;
}
function extractIds(payload) {
  if (!payload || typeof payload !== "object")
    return [];
  const data = payload.data;
  if (!Array.isArray(data))
    return [];
  const ids = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object")
      continue;
    const id = entry.id;
    if (typeof id === "string" && id.trim())
      ids.push(id.trim());
  }
  return ids;
}
async function fetchCatalogIds(baseURL, timeoutMs, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError;
  for (let attempt = 0;attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(modelsURL(baseURL), { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok)
        throw new Error(`HTTP ${response.status}`);
      const ids = extractIds(await response.json());
      if (ids.length === 0)
        throw new Error("catalog listed no models");
      return ids;
    } catch (error) {
      lastError = error;
      if (attempt === 0)
        await sleep(250);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
async function readCache(cacheFile) {
  try {
    const raw = JSON.parse(await readFile(cacheFile, "utf8"));
    if (typeof raw.baseURL !== "string" || typeof raw.fetchedAt !== "number")
      return;
    if (!Array.isArray(raw.ids))
      return;
    const ids = raw.ids.filter((id) => typeof id === "string" && id !== "");
    if (ids.length === 0)
      return;
    return { baseURL: raw.baseURL, fetchedAt: raw.fetchedAt, ids };
  } catch {
    return;
  }
}
async function writeCache(cacheFile, cache) {
  try {
    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, `${JSON.stringify(cache)}
`, { mode: 384 });
  } catch {}
}
async function loadCatalog(config, options) {
  const now = options.now ?? Date.now;
  const cacheFile = options.cacheFile ?? resolveCachePath();
  const ttlMs = config.ttlHours * 60 * 60 * 1000;
  const cached = await readCache(cacheFile);
  const matchingCache = cached && cached.baseURL === options.baseURL ? cached : undefined;
  if (matchingCache && now() - matchingCache.fetchedAt < ttlMs) {
    return { ids: new Set(matchingCache.ids), source: "cache", fetchedAt: matchingCache.fetchedAt };
  }
  try {
    const ids = await fetchCatalogIds(options.baseURL, config.timeoutMs, options);
    const fetchedAt = now();
    await writeCache(cacheFile, { baseURL: options.baseURL, fetchedAt, ids });
    return { ids: new Set(ids), source: "network", fetchedAt };
  } catch (error) {
    if (matchingCache) {
      return { ids: new Set(matchingCache.ids), source: "cache-stale", fetchedAt: matchingCache.fetchedAt };
    }
    throw error;
  }
}

// src/config.ts
import { readFile as readFile2 } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
var defaults = {
  providerID: "openrouter",
  ttlHours: 6,
  timeoutMs: 4000,
  onError: "open",
  allow: [],
  debug: false
};
var KNOWN_KEYS = new Set([
  "providerID",
  "baseURL",
  "ttlHours",
  "timeoutMs",
  "onError",
  "allow",
  "debug"
]);
function resolveConfigPath(env = process.env) {
  const explicit = env.OPENCODE_OPENROUTER_EU_CONFIG;
  if (explicit && explicit.trim())
    return explicit.trim();
  const configHome = env.XDG_CONFIG_HOME || join2(env.HOME || homedir2(), ".config");
  return join2(configHome, "opencode", "openrouter-eu.json");
}
function normalizeBaseURL(value) {
  if (typeof value !== "string")
    return;
  const trimmed = value.trim();
  if (!trimmed)
    return;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return;
  return trimmed.replace(/\/+$/, "");
}
function positiveNumber(value, fallback, name, warnings) {
  if (value === undefined)
    return fallback;
  if (typeof value === "number" && Number.isFinite(value) && value > 0)
    return value;
  warnings.push(`${name} must be a positive number, keeping ${fallback}`);
  return fallback;
}
function parseConfig(raw) {
  const warnings = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { config: { ...defaults }, warnings: ["config must be a JSON object, using defaults"] };
  }
  const input = raw;
  const config = { ...defaults, allow: [] };
  if (input.providerID !== undefined) {
    if (typeof input.providerID === "string" && input.providerID.trim()) {
      config.providerID = input.providerID.trim();
    } else {
      warnings.push("providerID must be a non-empty string, keeping openrouter");
    }
  }
  if (input.baseURL !== undefined) {
    const value = normalizeBaseURL(input.baseURL);
    if (value)
      config.baseURL = value;
    else
      warnings.push("baseURL must be an http(s) URL, ignoring it and using the provider setting");
  }
  config.ttlHours = positiveNumber(input.ttlHours, defaults.ttlHours, "ttlHours", warnings);
  config.timeoutMs = positiveNumber(input.timeoutMs, defaults.timeoutMs, "timeoutMs", warnings);
  if (input.onError !== undefined) {
    if (input.onError === "open" || input.onError === "closed")
      config.onError = input.onError;
    else
      warnings.push('onError must be "open" or "closed", keeping open');
  }
  if (input.allow !== undefined) {
    if (Array.isArray(input.allow)) {
      const allow = input.allow.filter((id) => typeof id === "string" && id.trim() !== "");
      if (allow.length !== input.allow.length)
        warnings.push("allow must only contain model IDs, dropping the rest");
      config.allow = allow.map((id) => id.trim());
    } else {
      warnings.push("allow must be an array of model IDs, ignoring it");
    }
  }
  if (input.debug !== undefined) {
    if (typeof input.debug === "boolean")
      config.debug = input.debug;
    else
      warnings.push("debug must be a boolean, keeping false");
  }
  const unknown = Object.keys(input).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length > 0)
    warnings.push(`ignoring unknown config keys: ${unknown.join(", ")}`);
  return { config, warnings };
}
async function loadConfig(path = resolveConfigPath()) {
  let text;
  try {
    text = await readFile2(path, "utf8");
  } catch (error) {
    const code = error.code;
    if (code === "ENOENT")
      return { config: { ...defaults, allow: [] }, warnings: [] };
    return {
      config: { ...defaults, allow: [] },
      warnings: [`cannot read ${path} (${code ?? "unknown error"}), using defaults`]
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { config: { ...defaults, allow: [] }, warnings: [`${path} is not valid JSON, using defaults`] };
  }
  return parseConfig(parsed);
}

// src/log.ts
function createLogger(debug, prefix = "[openrouter-eu]") {
  return {
    info: (message) => console.log(`${prefix} ${message}`),
    warn: (message) => console.warn(`${prefix} ${message}`),
    debug: (message) => {
      if (debug)
        console.log(`${prefix} debug: ${message}`);
    }
  };
}

// src/index.ts
function describe2(error) {
  return error instanceof Error ? error.message : String(error);
}
function providerBaseURL(registry, providerID) {
  if (!registry || typeof registry.get !== "function")
    return;
  try {
    const entry = registry.get(providerID);
    return normalizeBaseURL(entry?.provider?.settings?.baseURL);
  } catch {
    return;
  }
}
function filterModels(editor, config, catalogBaseURL, catalog, log) {
  const liveBaseURL = providerBaseURL(editor.provider, config.providerID);
  const effectiveBaseURL = liveBaseURL ?? config.baseURL;
  if (!effectiveBaseURL) {
    log.debug(`provider ${config.providerID} has no endpoint override, nothing to filter`);
    return;
  }
  if (isGlobalEndpoint(effectiveBaseURL)) {
    log.debug(`provider ${config.providerID} uses the global endpoint, nothing to filter`);
    return;
  }
  if (effectiveBaseURL !== catalogBaseURL) {
    log.warn(`provider ${config.providerID} points at ${effectiveBaseURL} but the catalog was read from ${catalogBaseURL}; ` + "set baseURL in the plugin config so they match");
    return;
  }
  const result = applyFilter(editor, {
    providerID: config.providerID,
    keep: catalog?.ids ?? new Set,
    allow: new Set(config.allow),
    catalogAvailable: catalog !== undefined,
    onError: config.onError
  });
  if (result.errors.length > 0) {
    const sample = result.errors.slice(0, 5).join(", ");
    log.warn(`could not remove ${result.errors.length} model(s): ${sample}${result.errors.length > 5 ? ", ..." : ""}`);
  }
  if (result.skipped) {
    log.warn("no catalog available, keeping every model (onError=open)");
    return;
  }
  log.info(`kept ${result.kept} model(s), removed ${result.removed.length}`);
}
async function setup(ctx, options = {}) {
  const { config, warnings } = await loadConfig(options.configPath);
  const log = createLogger(config.debug);
  for (const warning of warnings)
    log.warn(warning);
  if (!ctx?.model || typeof ctx.model.transform !== "function") {
    log.warn("ctx.model.transform is not available, plugin disabled (OpenCode V2 is required)");
    return;
  }
  const catalogBaseURL = config.baseURL ?? DEFAULT_EU_BASE_URL;
  if (isGlobalEndpoint(catalogBaseURL)) {
    log.info(`endpoint ${catalogBaseURL} is OpenRouter global, nothing to filter`);
    return;
  }
  let catalog;
  try {
    catalog = await loadCatalog(config, { ...options.catalog, baseURL: catalogBaseURL });
    log.debug(`catalog: ${catalog.ids.size} model(s) from ${catalog.source}`);
  } catch (error) {
    log.warn(`cannot load the regional catalog from ${catalogBaseURL}: ${describe2(error)}`);
  }
  ctx.model.transform((editor) => {
    try {
      filterModels(editor, config, catalogBaseURL, catalog, log);
    } catch (error) {
      log.warn(`filtering failed: ${describe2(error)}`);
    }
  });
}
var src_default = { id: PLUGIN_ID, setup };
export {
  src_default as default,
  filterModels,
  providerBaseURL,
  setup
};
