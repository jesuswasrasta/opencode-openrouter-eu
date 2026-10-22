import { describe, expect, test } from "bun:test"
import { applyFilter } from "../src/apply"
import type { OpenCodeModel, OpenCodeModelEditor } from "../src/types"

function editor(models: OpenCodeModel[], failOn: string[] = []): { editor: OpenCodeModelEditor; removed: string[] } {
  const removed: string[] = []
  const instance: OpenCodeModelEditor = {
    list: () => models,
    remove: (providerID, modelID) => {
      if (failOn.includes(modelID)) throw new Error(`cannot remove ${providerID}/${modelID}`)
      removed.push(modelID)
    },
  }
  return { editor: instance, removed }
}

const models: OpenCodeModel[] = [
  { id: "openai/gpt-5-mini", providerID: "openrouter" },
  { id: "mistralai/devstral-2512", providerID: "openrouter" },
  { id: "google/gemini-3.5-flash", providerID: "openrouter" },
  { id: "some-model", providerID: "ollama" },
]

describe("applyFilter", () => {
  test("removes models missing from the catalog, leaving other providers alone", () => {
    const { editor: target, removed } = editor(models)
    const result = applyFilter(target, {
      providerID: "openrouter",
      keep: new Set(["openai/gpt-5-mini", "mistralai/devstral-2512"]),
      allow: new Set(),
      catalogAvailable: true,
      onError: "open",
    })
    expect(removed).toEqual(["google/gemini-3.5-flash"])
    expect(result.kept).toBe(2)
    expect(result.removed).toEqual(["google/gemini-3.5-flash"])
    expect(result.skipped).toBe(false)
    expect(result.errors).toEqual([])
  })

  test("keeps allow-listed models even when the catalog omits them", () => {
    const { editor: target, removed } = editor(models)
    applyFilter(target, {
      providerID: "openrouter",
      keep: new Set(["openai/gpt-5-mini"]),
      allow: new Set(["google/gemini-3.5-flash"]),
      catalogAvailable: true,
      onError: "open",
    })
    expect(removed).toEqual(["mistralai/devstral-2512"])
  })

  test("matches on modelID when it differs from id", () => {
    const { editor: target, removed } = editor([{ id: "alias", providerID: "openrouter", modelID: "real/model" }])
    applyFilter(target, {
      providerID: "openrouter",
      keep: new Set(["real/model"]),
      allow: new Set(),
      catalogAvailable: true,
      onError: "open",
    })
    expect(removed).toEqual([])
  })

  test("keeps everything when the catalog is unavailable and onError is open", () => {
    const { editor: target, removed } = editor(models)
    const result = applyFilter(target, {
      providerID: "openrouter",
      keep: new Set(),
      allow: new Set(),
      catalogAvailable: false,
      onError: "open",
    })
    expect(result.skipped).toBe(true)
    expect(removed).toEqual([])
    expect(result.kept).toBe(0)
  })

  test("removes everything except allow when the catalog is unavailable and onError is closed", () => {
    const { editor: target, removed } = editor(models)
    const result = applyFilter(target, {
      providerID: "openrouter",
      keep: new Set(),
      allow: new Set(["openai/gpt-5-mini"]),
      catalogAvailable: false,
      onError: "closed",
    })
    expect(result.skipped).toBe(false)
    expect(removed).toEqual(["mistralai/devstral-2512", "google/gemini-3.5-flash"])
  })

  test("removes the Auto Router, which OpenRouter refuses inside a data region", () => {
    const { editor: target, removed } = editor([
      { id: "openrouter/auto", providerID: "openrouter" },
      { id: "openai/gpt-5-mini", providerID: "openrouter" },
    ])
    const result = applyFilter(target, {
      providerID: "openrouter",
      keep: new Set(["openai/gpt-5-mini"]),
      allow: new Set(),
      catalogAvailable: true,
      onError: "open",
    })
    expect(removed).toEqual(["openrouter/auto"])
    expect(result.kept).toBe(1)
  })

  test("keeps a router that is explicitly allow-listed", () => {
    const { editor: target, removed } = editor([{ id: "openrouter/pareto-code", providerID: "openrouter" }])
    applyFilter(target, {
      providerID: "openrouter",
      keep: new Set(),
      allow: new Set(["openrouter/pareto-code"]),
      catalogAvailable: true,
      onError: "open",
    })
    expect(removed).toEqual([])
  })

  test("keeps going when a single removal fails", () => {
    const { editor: target, removed } = editor(models, ["mistralai/devstral-2512"])
    const result = applyFilter(target, {
      providerID: "openrouter",
      keep: new Set(["openai/gpt-5-mini"]),
      allow: new Set(),
      catalogAvailable: true,
      onError: "open",
    })
    expect(removed).toEqual(["google/gemini-3.5-flash"])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain("mistralai/devstral-2512")
  })

  test("reports a broken registry without throwing", () => {
    const broken: OpenCodeModelEditor = {
      list: () => {
        throw new Error("registry exploded")
      },
      remove: () => {},
    }
    const result = applyFilter(broken, {
      providerID: "openrouter",
      keep: new Set(),
      allow: new Set(),
      catalogAvailable: true,
      onError: "open",
    })
    expect(result.errors[0]).toContain("registry exploded")
  })
})
