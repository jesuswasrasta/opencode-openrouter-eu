import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaults, loadConfig, normalizeBaseURL, parseConfig } from "../src/config"

async function tempFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oreu-config-"))
  const file = join(dir, "openrouter-eu.json")
  await writeFile(file, content)
  return file
}

describe("parseConfig", () => {
  test("returns defaults for an empty object", () => {
    const { config, warnings } = parseConfig({})
    expect(config).toEqual(defaults)
    expect(warnings).toEqual([])
  })

  test("accepts a full configuration", () => {
    const { config, warnings } = parseConfig({
      providerID: "openrouter",
      baseURL: "https://eu.openrouter.ai/api/v1/",
      ttlHours: 12,
      timeoutMs: 1500,
      onError: "closed",
      allow: ["openai/gpt-5-mini"],
      debug: true,
    })
    expect(warnings).toEqual([])
    expect(config.baseURL).toBe("https://eu.openrouter.ai/api/v1")
    expect(config.ttlHours).toBe(12)
    expect(config.timeoutMs).toBe(1500)
    expect(config.onError).toBe("closed")
    expect(config.allow).toEqual(["openai/gpt-5-mini"])
    expect(config.debug).toBe(true)
  })

  test("falls back with a warning on invalid values", () => {
    const { config, warnings } = parseConfig({
      providerID: "",
      baseURL: "not a url",
      ttlHours: -1,
      timeoutMs: "soon",
      onError: "maybe",
      allow: ["ok", 42],
      debug: "yes",
    })
    expect(config.providerID).toBe(defaults.providerID)
    expect(config.baseURL).toBeUndefined()
    expect(config.ttlHours).toBe(defaults.ttlHours)
    expect(config.timeoutMs).toBe(defaults.timeoutMs)
    expect(config.onError).toBe(defaults.onError)
    expect(config.allow).toEqual(["ok"])
    expect(config.debug).toBe(false)
    expect(warnings.length).toBeGreaterThanOrEqual(6)
  })

  test("reports unknown keys", () => {
    const { warnings } = parseConfig({ ttlHour: 3 })
    expect(warnings.join(" ")).toContain("unknown config keys: ttlHour")
  })

  test("rejects non-object roots", () => {
    expect(parseConfig([]).warnings).toContain("config must be a JSON object, using defaults")
    expect(parseConfig("nope").config).toEqual(defaults)
  })
})

describe("normalizeBaseURL", () => {
  test("strips trailing slashes", () => {
    expect(normalizeBaseURL("https://eu.openrouter.ai/api/v1///")).toBe("https://eu.openrouter.ai/api/v1")
  })

  test("rejects non http(s) schemes and junk", () => {
    expect(normalizeBaseURL("ftp://example.com")).toBeUndefined()
    expect(normalizeBaseURL("   ")).toBeUndefined()
    expect(normalizeBaseURL(42)).toBeUndefined()
  })
})

describe("loadConfig", () => {
  test("uses defaults when the file is missing", async () => {
    const { config, warnings } = await loadConfig("/nonexistent/openrouter-eu.json")
    expect(config).toEqual(defaults)
    expect(warnings).toEqual([])
  })

  test("warns when the file is not valid JSON", async () => {
    const file = await tempFile("{ nope")
    const { config, warnings } = await loadConfig(file)
    expect(config).toEqual(defaults)
    expect(warnings[0]).toContain("is not valid JSON")
  })

  test("reads a valid file", async () => {
    const file = await tempFile(JSON.stringify({ ttlHours: 2 }))
    const { config } = await loadConfig(file)
    expect(config.ttlHours).toBe(2)
  })
})
