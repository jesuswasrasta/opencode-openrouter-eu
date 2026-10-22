import type { FailMode } from "./config"
import type { OpenCodeModelEditor } from "./types"

export interface ApplyOptions {
  providerID: string
  /** Model IDs the regional catalog advertises. */
  keep: ReadonlySet<string>
  /** Model IDs that are always kept, even when absent from the catalog. */
  allow: ReadonlySet<string>
  /** False when no catalog could be loaded and the cache was empty. */
  catalogAvailable: boolean
  onError: FailMode
}

export interface ApplyResult {
  removed: string[]
  kept: number
  /** True when the filter was skipped because of the fail-open policy. */
  skipped: boolean
  errors: string[]
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Removes every model of the target provider that the regional catalog does not
 * advertise. Pure with respect to the editor passed in, so it is testable
 * without an OpenCode runtime.
 */
export function applyFilter(editor: OpenCodeModelEditor, options: ApplyOptions): ApplyResult {
  const result: ApplyResult = { removed: [], kept: 0, skipped: false, errors: [] }

  if (!options.catalogAvailable && options.onError === "open") {
    result.skipped = true
    return result
  }

  let models: readonly { id: string; providerID: string; modelID?: string }[]
  try {
    models = editor.list()
  } catch (error) {
    result.errors.push(`cannot list models: ${describe(error)}`)
    return result
  }

  for (const model of models) {
    if (!model || model.providerID !== options.providerID) continue
    const id = model.modelID ?? model.id
    if (!id) continue

    const keep = options.keep.has(id) || options.keep.has(model.id) || options.allow.has(id) || options.allow.has(model.id)
    if (keep) {
      result.kept += 1
      continue
    }

    try {
      editor.remove(options.providerID, id)
      result.removed.push(id)
    } catch (error) {
      result.errors.push(`${id}: ${describe(error)}`)
    }
  }

  return result
}
