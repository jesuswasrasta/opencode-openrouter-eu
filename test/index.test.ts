import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaults, type Config } from "../src/config"
import { filterModels, providerBaseURL, setup, type SetupOptions } from "../src/index"
import type { Logger } from "../src/log"
import type { OpenCodeModel, OpenCodeModelEditor, OpenCodePluginContext } from "../src/types"

function config(overrides: Partial<Config> = {}): Config {
  return { ...defaults, allow: [], ...overrides }
}

function silentLogger(): Logger & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: (message) => lines.push(`info: ${message}`),
    warn: (message) => lines.push(`warn: ${message}`),
    debug: (message) => lines.push(`debug: ${message}`),
  }
}

const models: OpenCodeModel[] = [
  { id: "openai/gpt-5-mini", providerID: "openrouter" },
  { id: "google/gemini-3.5-flash", providerID: "openrouter" },
]

function editor(providerBaseURLValue?: string): { editor: OpenCodeModelEditor; removed: string[] } {
  const removed: string[] = []
  const instance: OpenCodeModelEditor = {
    list: () => models,
    remove: (_providerID, modelID) => {
      removed.push(modelID)
    },
    ...(providerBaseURLValue
      ? {
          provider: {
            list: () => [],
            get: (id: string) =>
              id === "openrouter"
                ? { provider: { id, settings: { baseURL: providerBaseURLValue } } }
                : undefined,
          },
        }
      : {}),
  }
  return { editor: instance, removed }
}

const EU = "https://eu.openrouter.ai/api/v1"

describe("providerBaseURL", () => {
  test("reads and normalizes the provider endpoint", () => {
    const { editor: target } = editor(`${EU}/`)
    expect(providerBaseURL(target.provider, "openrouter")).toBe(EU)
  })

  test("returns undefined for unknown providers and broken registries", () => {
    const { editor: target } = editor(EU)
    expect(providerBaseURL(target.provider, "nope")).toBeUndefined()
    expect(providerBaseURL(undefined, "openrouter")).toBeUndefined()
    expect(
      providerBaseURL({ list: () => [], get: () => { throw new Error("boom") } }, "openrouter"),
    ).toBeUndefined()
  })
})

describe("filterModels", () => {
  test("filters when the live provider endpoint matches the catalog", () => {
    const { editor: target, removed } = editor(EU)
    const log = silentLogger()
    filterModels(target, config(), EU, { ids: new Set(["openai/gpt-5-mini"]), source: "network", fetchedAt: 0 }, log)
    expect(removed).toEqual(["google/gemini-3.5-flash"])
    expect(log.lines.join(" ")).toContain("kept 1 model(s), removed 1")
  })

  test("removes the Auto Router and explains why", () => {
    const removed: string[] = []
    const target: OpenCodeModelEditor = {
      list: () => [
        { id: "openrouter/auto", providerID: "openrouter", modelID: "openrouter/auto" },
        { id: "openai/gpt-5-mini", providerID: "openrouter", modelID: "openai/gpt-5-mini" },
      ],
      remove: (_providerID, modelID) => {
        removed.push(modelID)
      },
      provider: {
        list: () => [],
        get: (id) =>
          id === "openrouter" ? { provider: { id, settings: { baseURL: EU } } } : undefined,
      },
    }
    const log = silentLogger()
    filterModels(target, config(), EU, { ids: new Set(["openai/gpt-5-mini"]), source: "network", fetchedAt: 0 }, log)
    expect(removed).toEqual(["openrouter/auto"])
    expect(log.lines.join(" ")).toContain("Auto Router")
    expect(log.lines.join(" ")).toContain("HTTP 400")
  })

  test("stays inert when the provider has no endpoint override", () => {
    const { editor: target, removed } = editor()
    const log = silentLogger()
    filterModels(target, config(), EU, { ids: new Set(), source: "network", fetchedAt: 0 }, log)
    expect(removed).toEqual([])
    expect(log.lines.join(" ")).toContain("no endpoint override")
  })

  test("stays inert on the global endpoint", () => {
    const { editor: target, removed } = editor("https://openrouter.ai/api/v1")
    const log = silentLogger()
    filterModels(target, config(), EU, { ids: new Set(), source: "network", fetchedAt: 0 }, log)
    expect(removed).toEqual([])
    expect(log.lines.join(" ")).toContain("global endpoint")
  })

  test("refuses to filter when the catalog came from another endpoint", () => {
    const { editor: target, removed } = editor("https://another.gateway/api/v1")
    const log = silentLogger()
    filterModels(target, config(), EU, { ids: new Set(["openai/gpt-5-mini"]), source: "network", fetchedAt: 0 }, log)
    expect(removed).toEqual([])
    expect(log.lines.join(" ")).toContain("set baseURL in the plugin config")
  })

  test("honours onError=open when the catalog is missing", () => {
    const { editor: target, removed } = editor(EU)
    const log = silentLogger()
    filterModels(target, config(), EU, undefined, log)
    expect(removed).toEqual([])
    expect(log.lines.join(" ")).toContain("onError=open")
  })

  test("honours onError=closed when the catalog is missing", () => {
    const { editor: target, removed } = editor(EU)
    const log = silentLogger()
    filterModels(target, config({ onError: "closed", allow: ["openai/gpt-5-mini"] }), EU, undefined, log)
    expect(removed).toEqual(["google/gemini-3.5-flash"])
  })
})

describe("setup", () => {
  test("disables itself when the V2 model hook is absent", async () => {
    const log = await captureSetup({} as OpenCodePluginContext, silentDeps())
    expect(log).toContain("plugin disabled")
  })

  test("registers a transform that filters through the injected catalog", async () => {
    let captured: ((editor: OpenCodeModelEditor) => void) | undefined
    const ctx = {
      model: {
        transform: (apply: (editor: OpenCodeModelEditor) => void) => {
          captured = apply
        },
      },
    } as unknown as OpenCodePluginContext

    await setup(ctx, silentDeps())
    expect(typeof captured).toBe("function")

    const { editor: target, removed } = editor(EU)
    captured?.(target)
    expect(removed).toEqual(["google/gemini-3.5-flash"])
  })

  test("stays inert when the configured endpoint is the global one", async () => {
    let registered = 0
    const ctx = {
      model: {
        transform: () => {
          registered += 1
        },
      },
    } as unknown as OpenCodePluginContext
    const log = await captureSetup(ctx, { ...silentDeps(), configPath: await configFile({ baseURL: "https://openrouter.ai/api/v1" }) })
    expect(registered).toBe(0)
    expect(log).toContain("nothing to filter")
  })
})

function silentDeps(): SetupOptions {
  return {
    catalog: {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ data: [{ id: "openai/gpt-5-mini" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
      sleep: async () => {},
      cacheFile: `${process.env.TMPDIR ?? "/tmp"}/oreu-test-cache-${Math.random().toString(36).slice(2)}.json`,
    },
  }
}

async function configFile(body: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oreu-setup-"))
  const file = join(dir, "openrouter-eu.json")
  await writeFile(file, JSON.stringify(body))
  return file
}

async function captureSetup(ctx: OpenCodePluginContext, options: SetupOptions = {}): Promise<string> {
  const lines: string[] = []
  const originalWarn = console.warn
  const originalLog = console.log
  console.warn = (message: string) => lines.push(String(message))
  console.log = (message: string) => lines.push(String(message))
  try {
    await setup(ctx, options)
  } finally {
    console.warn = originalWarn
    console.log = originalLog
  }
  return lines.join(" ")
}
