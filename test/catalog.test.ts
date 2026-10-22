import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaults, type Config } from "../src/config"
import {
  extractIds,
  isGlobalEndpoint,
  loadCatalog,
  modelsURL,
  readCache,
  type CatalogDeps,
} from "../src/catalog"

function config(overrides: Partial<Config> = {}): Config {
  return { ...defaults, allow: [], ...overrides }
}

async function cacheFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oreu-catalog-"))
  return join(dir, "cache.json")
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function fetchSequence(bodies: Array<Response | Error>): { fetchImpl: typeof fetch; calls: () => number } {
  let index = 0
  const fetchImpl = (async () => {
    const body = bodies[Math.min(index, bodies.length - 1)]
    index += 1
    if (body instanceof Error) throw body
    return body
  }) as unknown as typeof fetch
  return { fetchImpl, calls: () => index }
}

const EU_BODY = { data: [{ id: "openai/gpt-5-mini" }, { id: "mistralai/devstral-2512" }] }

describe("helpers", () => {
  test("modelsURL appends /models without doubling slashes", () => {
    expect(modelsURL("https://eu.openrouter.ai/api/v1")).toBe("https://eu.openrouter.ai/api/v1/models")
    expect(modelsURL("https://eu.openrouter.ai/api/v1/")).toBe("https://eu.openrouter.ai/api/v1/models")
  })

  test("isGlobalEndpoint only matches the global hosts", () => {
    expect(isGlobalEndpoint("https://openrouter.ai/api/v1")).toBe(true)
    expect(isGlobalEndpoint("https://www.openrouter.ai/api/v1")).toBe(true)
    expect(isGlobalEndpoint("https://eu.openrouter.ai/api/v1")).toBe(false)
    expect(isGlobalEndpoint("https://gateway.internal/api/v1")).toBe(false)
    expect(isGlobalEndpoint("garbage")).toBe(false)
  })

  test("extractIds tolerates malformed payloads", () => {
    expect(extractIds(EU_BODY)).toEqual(["openai/gpt-5-mini", "mistralai/devstral-2512"])
    expect(extractIds({ data: [{ id: 42 }, { id: "  " }, null, { id: "ok/model" }] })).toEqual(["ok/model"])
    expect(extractIds({ data: "nope" })).toEqual([])
    expect(extractIds(null)).toEqual([])
  })
})

describe("loadCatalog", () => {
  test("fetches and caches the regional catalog", async () => {
    const file = await cacheFile()
    const { fetchImpl, calls } = fetchSequence([jsonResponse(EU_BODY)])
    const result = await loadCatalog(config(), {
      baseURL: "https://eu.openrouter.ai/api/v1",
      cacheFile: file,
      fetchImpl,
      sleep: async () => {},
    })
    expect(result.source).toBe("network")
    expect([...result.ids]).toEqual(["openai/gpt-5-mini", "mistralai/devstral-2512"])
    expect(calls()).toBe(1)
    expect((await readCache(file))?.ids.length).toBe(2)
  })

  test("serves a fresh cache without touching the network", async () => {
    const file = await cacheFile()
    const base = "https://eu.openrouter.ai/api/v1"
    const { fetchImpl } = fetchSequence([jsonResponse(EU_BODY)])
    await loadCatalog(config(), { baseURL: base, cacheFile: file, fetchImpl, sleep: async () => {} })

    const second = await loadCatalog(config(), {
      baseURL: base,
      cacheFile: file,
      fetchImpl: (() => {
        throw new Error("network must not be used")
      }) as unknown as typeof fetch,
    })
    expect(second.source).toBe("cache")
    expect(second.ids.size).toBe(2)
  })

  test("refetches once the ttl expired", async () => {
    const file = await cacheFile()
    const base = "https://eu.openrouter.ai/api/v1"
    const first = fetchSequence([jsonResponse(EU_BODY)])
    await loadCatalog(config({ ttlHours: 1 }), {
      baseURL: base,
      cacheFile: file,
      fetchImpl: first.fetchImpl,
      sleep: async () => {},
    })
    const second = fetchSequence([jsonResponse({ data: [{ id: "only/one" }] })])
    const result = await loadCatalog(config({ ttlHours: 1 }), {
      baseURL: base,
      cacheFile: file,
      fetchImpl: second.fetchImpl,
      now: () => Date.now() + 2 * 60 * 60 * 1000,
      sleep: async () => {},
    })
    expect(result.source).toBe("network")
    expect([...result.ids]).toEqual(["only/one"])
  })

  test("falls back to the stale cache when the network fails", async () => {
    const file = await cacheFile()
    const base = "https://eu.openrouter.ai/api/v1"
    const first = fetchSequence([jsonResponse(EU_BODY)])
    await loadCatalog(config({ ttlHours: 1 }), {
      baseURL: base,
      cacheFile: file,
      fetchImpl: first.fetchImpl,
      sleep: async () => {},
    })
    const failing = fetchSequence([new Error("offline"), new Error("offline")])
    const result = await loadCatalog(config({ ttlHours: 1 }), {
      baseURL: base,
      cacheFile: file,
      fetchImpl: failing.fetchImpl,
      now: () => Date.now() + 48 * 60 * 60 * 1000,
      sleep: async () => {},
    })
    expect(result.source).toBe("cache-stale")
    expect(result.ids.size).toBe(2)
  })

  test("retries once before giving up", async () => {
    const file = await cacheFile()
    const { fetchImpl, calls } = fetchSequence([jsonResponse({}, 502), jsonResponse(EU_BODY)])
    const result = await loadCatalog(config(), {
      baseURL: "https://eu.openrouter.ai/api/v1",
      cacheFile: file,
      fetchImpl,
      sleep: async () => {},
    })
    expect(result.source).toBe("network")
    expect(calls()).toBe(2)
  })

  test("throws when there is neither network nor cache", async () => {
    const file = await cacheFile()
    const { fetchImpl } = fetchSequence([new Error("offline"), new Error("offline")])
    await expect(
      loadCatalog(config(), { baseURL: "https://eu.openrouter.ai/api/v1", cacheFile: file, fetchImpl, sleep: async () => {} }),
    ).rejects.toThrow("offline")
  })

  test("ignores a cache written for a different endpoint", async () => {
    const file = await cacheFile()
    const first = fetchSequence([jsonResponse(EU_BODY)])
    await loadCatalog(config(), {
      baseURL: "https://eu.openrouter.ai/api/v1",
      cacheFile: file,
      fetchImpl: first.fetchImpl,
      sleep: async () => {},
    })
    const failing = fetchSequence([new Error("offline"), new Error("offline")])
    await expect(
      loadCatalog(config(), {
        baseURL: "https://other.example.com/api/v1",
        cacheFile: file,
        fetchImpl: failing.fetchImpl,
        sleep: async () => {},
      }),
    ).rejects.toThrow("offline")
  })
})

describe("fetch timeout wiring", () => {
  test("uses the configured timeout", async () => {
    const file = await cacheFile()
    let observed: RequestInit | undefined
    const deps: CatalogDeps = {
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        observed = init
        return jsonResponse(EU_BODY)
      }) as unknown as typeof fetch,
    }
    await loadCatalog(config({ timeoutMs: 1234 }), {
      ...deps,
      baseURL: "https://eu.openrouter.ai/api/v1",
      cacheFile: file,
      sleep: async () => {},
    })
    expect(observed?.signal).toBeInstanceOf(AbortSignal)
  })
})
