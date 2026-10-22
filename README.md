# opencode-openrouter-eu

OpenCode plugin that keeps only the OpenRouter models that can actually be served from a single data region (Europe by default).

## Why this exists

When an OpenRouter API key is restricted to a data region, for example an organisation on the Business plan with `allowed_data_regions: ["europe"]`, OpenRouter only accepts models that have an endpoint inside that region. Anything else fails at request time:

```
404 No endpoints found supporting your data region
```

There is no cross-region fallback, by design.

The correct fix is to point the provider at the in-region endpoint:

```jsonc
{
  "providers": {
    "openrouter": {
      "settings": { "baseURL": "https://eu.openrouter.ai/api/v1" }
    }
  }
}
```

That moves the traffic, but not the model catalog: OpenCode builds the OpenRouter model list from [models.dev](https://models.dev), which is global and has no notion of region. The picker therefore still offers hundreds of models that will fail, and the documented `whitelist` / `blacklist` options are ignored by OpenCode V2 (`packages/core/src/config/normalize.ts` lists them as unsupported).

This plugin closes that gap. It reads `GET {baseURL}/models`; the in-region endpoint already returns only the models that region can serve (67 models at the time of writing, against 468 on the global endpoint), and removes every other OpenRouter model from the registry.

## Requirements

- OpenCode **V2** (developed and tested against 2.1.2)
- An OpenRouter account whose key is allowed in the target region
- The OpenRouter provider already connected: `opencode auth login openrouter`
- Network access to the in-region endpoint at least once; afterwards the catalog is cached

OpenCode V1 is **not** supported and does not need this plugin: V1 honours `provider.whitelist` natively. The V2 plugin contract (`export default { id, setup }` plus `ctx.model.transform`) does not exist in V1, so on V1 the plugin is simply never loaded.

## Install

Pick one.

**From Git** (no npm publishing needed):

```bash
opencode plugin add github:<owner>/opencode-openrouter-eu
```

**From npm**, once published:

```bash
opencode plugin add opencode-openrouter-eu
```

**By hand**, as a local file:

```bash
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://raw.githubusercontent.com/<owner>/opencode-openrouter-eu/main/dist/index.js \
  -o ~/.config/opencode/plugins/openrouter-eu.js
```

The `plugin add` forms record the plugin in the global `opencode.json` for you. The manual form needs no config entry: files in `~/.config/opencode/plugins/` are loaded automatically.

Then restart OpenCode.

## Verify the install

```bash
opencode plugin list
```

Expected: a row with id `openrouter-eu`.

```bash
opencode models | grep -c '^openrouter/'
```

The number must match the in-region catalog:

```bash
curl -s https://eu.openrouter.ai/api/v1/models | jq '.data | length'
```

Do not hardcode the expected count: it changes as OpenRouter adds models. What matters is that the two numbers agree.

## Configuration

Optional. Without a config file the defaults are used.

Default location: `~/.config/opencode/openrouter-eu.json`
Override: `OPENCODE_OPENROUTER_EU_CONFIG=/path/to/file.json`

```json
{
  "providerID": "openrouter",
  "baseURL": "https://eu.openrouter.ai/api/v1",
  "ttlHours": 6,
  "timeoutMs": 4000,
  "onError": "open",
  "allow": [],
  "debug": false
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `providerID` | `openrouter` | Provider whose model list is filtered |
| `baseURL` | the provider's own `baseURL`, else `https://eu.openrouter.ai/api/v1` | Endpoint used to read the regional catalog |
| `ttlHours` | `6` | How long a cached catalog stays valid |
| `timeoutMs` | `4000` | Timeout for one catalog request |
| `onError` | `open` | No catalog available: `open` keeps every model, `closed` removes all but `allow` |
| `allow` | `[]` | Model IDs that always survive, even if absent from the catalog |
| `debug` | `false` | Verbose logging |

Unknown keys and invalid values produce a warning and are ignored; the plugin never fails to load because of configuration.

### How the endpoint is resolved

1. `baseURL` from the config file, when set;
2. otherwise the live `providers.<id>.settings.baseURL` from the OpenCode registry;
3. otherwise `https://eu.openrouter.ai/api/v1`.

If the resolved endpoint is OpenRouter's global one (`https://openrouter.ai/api/v1`), the plugin stays inert: filtering the global catalog would be wrong. If the endpoint the provider actually uses differs from the one the catalog was read from, the plugin logs a warning and does not filter, so it can never hide models that would have worked.

## Behaviour

- Runs once per model registry load, never per request.
- Removes models only. It never adds, renames or reorders anything.
- A failed removal of one model is logged and does not stop the others.
- The catalog is cached at `$XDG_CACHE_HOME/opencode/openrouter-eu-models.json` (mode `0600`).
- Cache precedence: fresh cache, then network (one retry), then stale cache for the same endpoint, then the `onError` policy.
- `onError: "open"` is the default because OpenRouter already refuses out-of-region models: a network hiccup costs accuracy, not compliance.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Hundreds of OpenRouter models | Plugin not loaded: check `opencode plugin list`, restart the server, check `--print-logs` for `openrouter-eu` |
| `[openrouter-eu] ... no endpoint override` | The provider has no `baseURL` override, so it is using the global catalog |
| `[openrouter-eu] ... global endpoint` | The provider points at `openrouter.ai` instead of the in-region host |
| `[openrouter-eu] ... set baseURL in the plugin config` | Provider and catalog endpoints disagree; set `baseURL` explicitly |
| `[openrouter-eu] cannot load the regional catalog` | Network failure with an empty cache; with `onError: open` nothing is filtered |
| `[openrouter-eu] ctx.model.transform is not available` | Not OpenCode V2; on V1 use `provider.whitelist` instead |
| `Model unavailable: openrouter/...` | Working as intended: the model is not served in this region |

Logs are printed by the OpenCode server; run `opencode --print-logs` or set `OPENCODE_LOG_LEVEL=debug`.

## Security notes

- The only outbound request is an unauthenticated `GET {baseURL}/models`; no API key is sent, stored or logged by this plugin.
- The cache contains model IDs and nothing else.
- The plugin does not alter request bodies or headers, so OpenRouter's own in-region enforcement remains the source of truth.

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun test            # unit tests, no network
bun run build       # dist/index.js, ESM bundle
bun run check       # all of the above
```

Layout:

| Path | Role |
| --- | --- |
| `src/index.ts` | plugin entry point and orchestration |
| `src/apply.ts` | pure filter over the model registry |
| `src/catalog.ts` | fetch, cache and TTL |
| `src/config.ts` | config loading and validation |
| `src/types.ts` | minimal typing of the V2 plugin contract |
| `test/` | unit tests with injected `fetch` and fake editors |

The OpenCode V2 plugin types are not published on npm (`@opencode-ai/plugin` stops at 1.19.x, the V1 API), so `src/types.ts` declares only the surface this plugin uses, and every access is guarded at runtime.

To publish to npm: `bun run build && npm publish`.

## License

MIT
