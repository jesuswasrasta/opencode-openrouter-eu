export const PLUGIN_ID = "openrouter-eu"

/**
 * OpenRouter's Auto Router. Region-specific endpoints refuse it with HTTP 400
 * ("The openrouter/auto router is not available in your data region"), so it
 * cannot be offered inside a data region.
 */
export const AUTO_ROUTER_ID = "openrouter/auto"

/**
 * OpenRouter's in-region endpoint for the European data region. Requests sent
 * here are decrypted and processed inside the EU only, and OpenRouter refuses
 * models without an EU capable endpoint instead of falling back globally.
 */
export const DEFAULT_EU_BASE_URL = "https://eu.openrouter.ai/api/v1"

/**
 * Endpoints that expose the global, region-agnostic catalog. When a provider is
 * pointed at one of these there is nothing to filter, so the plugin stays inert.
 */
export const GLOBAL_HOSTS = ["openrouter.ai", "www.openrouter.ai"]

export const CACHE_FILE_NAME = "openrouter-eu-models.json"

export const LOG_PREFIX = `[${PLUGIN_ID}]`
