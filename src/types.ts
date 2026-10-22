/**
 * Minimal typing for the OpenCode V2 plugin runtime.
 *
 * OpenCode V2 does not publish plugin types on npm: `@opencode-ai/plugin` stops
 * at 1.19.x, which describes the V1 hook API (`config`, `tool.execute.*`). The
 * V2 runtime instead hands the plugin an Effect based context; the surface this
 * plugin needs is `model.transform(editor)` and, on the editor, the model list
 * plus an optional provider registry.
 *
 * Only the members actually used are declared, and every access is guarded at
 * runtime, so an unexpected shape degrades to a logged no-op instead of
 * breaking the OpenCode boot.
 */

export interface OpenCodeModel {
  readonly id: string
  readonly providerID: string
  readonly modelID?: string
}

export interface OpenCodeProviderSettings {
  readonly baseURL?: unknown
  readonly [key: string]: unknown
}

export interface OpenCodeProviderInfo {
  readonly id: string
  readonly name?: string
  readonly package?: string
  readonly settings?: OpenCodeProviderSettings
}

export interface OpenCodeProviderEntry {
  readonly provider: OpenCodeProviderInfo
  readonly models?: Record<string, unknown>
}

export interface OpenCodeProviderRegistry {
  list(): readonly OpenCodeProviderEntry[]
  get(providerID: string): OpenCodeProviderEntry | undefined
}

export interface OpenCodeModelEditor {
  list(): readonly OpenCodeModel[]
  get?(providerID: string, modelID: string): OpenCodeModel | undefined
  remove(providerID: string, modelID: string): void
  readonly provider?: OpenCodeProviderRegistry
}

export interface OpenCodePluginContext {
  readonly model?: {
    transform(apply: (editor: OpenCodeModelEditor) => void): unknown
  }
}
