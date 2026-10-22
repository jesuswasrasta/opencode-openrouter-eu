export interface Logger {
  info(message: string): void
  warn(message: string): void
  debug(message: string): void
}

export function createLogger(debug: boolean, prefix = "[openrouter-eu]"): Logger {
  return {
    info: (message) => console.log(`${prefix} ${message}`),
    warn: (message) => console.warn(`${prefix} ${message}`),
    debug: (message) => {
      if (debug) console.log(`${prefix} debug: ${message}`)
    },
  }
}
