# Known limitations

This plugin keeps only the models that the configured in-region endpoint
advertises. That makes the picker honest, but it also means some OpenRouter
features are missing or behave differently. This page lists what has been
observed, so users do not mistake a regional restriction for a plugin bug.

The behaviour comes from OpenRouter, not from the plugin. It applies to any
region the plugin is configured for, although the examples below use the
European endpoint (`https://eu.openrouter.ai/api/v1`).

## Region-restricted workspaces

When a workspace sets `allowed_data_regions`, OpenRouter accepts requests only
on the matching in-region host and refuses models that have no endpoint in that
region. There is no cross-region fallback: a request either stays in-region or
fails.

The plugin reads the catalog of that same endpoint, so the models it leaves in
the picker are the ones the region can serve. Models outside the catalog are
removed instead of being offered and failing later.

## Routers

Routers are meta-models: instead of answering themselves, they pick another
model at request time. OpenRouter documents them in its [routers
guide](https://openrouter.ai/docs/guides/routing/routers), and states that
router-type models (such as the Auto Router) are [excluded from regional model
lists](https://openrouter.ai/docs/guides/features/in-region-routing). The plugin
therefore removes them all. What they actually do in-region differs from router
to router:

| Router | Observed response in-region | Usable |
| --- | --- | --- |
| [`openrouter/auto`](https://openrouter.ai/docs/guides/routing/routers/auto-router) | `400`, explicitly not available in a data region | no |
| [`openrouter/free`](https://openrouter.ai/docs/guides/routing/routers/free-router) | `404`, no endpoints support the data region | no |
| [`openrouter/bodybuilder`](https://openrouter.ai/docs/guides/routing/routers/body-builder) | `404`, no endpoints support the data region | no |
| [`openrouter/fusion`](https://openrouter.ai/docs/guides/routing/routers/fusion-router) | `403`, not available on region-specific endpoints | no |
| [`openrouter/pareto-code`](https://openrouter.ai/docs/guides/routing/routers/pareto-router) | `200`, routes to a model with an in-region endpoint | yes |

Status codes and catalog contents were observed on the European endpoint on
2026-10-22. OpenRouter can change them at any time, and it can add routers that
this table does not mention: the plugin hides them until they appear in the
catalog or you allow-list them.

### Auto Router (`openrouter/auto`)

The [Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router) is refused inside a data region:

```json
{
  "error": {
    "message": "The openrouter/auto router is not available in your data region. Choose a model directly or use the global API endpoint (openrouter.ai).",
    "code": 400
  }
}
```

Pointing the provider at the global endpoint is not a workaround: a workspace
restricted to a region rejects global requests with `403`.

Because the in-region catalog does not list the Auto Router, the plugin removes
it and logs why:

```
[openrouter-eu] openrouter/auto (Auto Router) was removed because OpenRouter refuses it inside a data region (HTTP 400 "The openrouter/auto router is not available in your data region"). Pick a model explicitly.
```

A missing `openrouter/auto` is therefore expected, not a bug.

### Pareto Code Router (`openrouter/pareto-code`)

The [Pareto Router](https://openrouter.ai/docs/guides/routing/routers/pareto-router)
(`openrouter/pareto-code`) is the exception: the in-region catalog does not list
it, but the endpoint serves it. It routes to a model that has an in-region
endpoint, so the request succeeds.

Since the plugin trusts the catalog, it hides `pareto-code` like every other
router. To keep it in the picker, allow-list it explicitly:

```json
{
  "allow": ["openrouter/pareto-code"]
}
```

Config file: `~/.config/opencode/openrouter-eu.json`, or the path in
`OPENCODE_OPENROUTER_EU_CONFIG`.

`allow` bypasses the catalog: it does not verify anything. A router can change
its target model over time, so use it deliberately.

## The global endpoint is not an escape hatch

If the provider points at `https://openrouter.ai/api/v1`, the plugin stays
inert, because filtering the global catalog would be wrong. That does not help
a region-restricted workspace: OpenRouter rejects requests to the global host
with `403` when the workspace allows only in-region hosts.

The plugin never changes request headers or bodies, so OpenRouter's own
enforcement remains the source of truth.

## `Model unavailable: openrouter/...`

This message means the plugin removed the model because the in-region catalog
does not list it. It is the expected outcome for out-of-region models and for
routers, and it is preferable to a request that fails later.

If a model is missing but does work in-region, it is a catalog gap: keep it
with `allow` and report it, so the workaround is visible.

## Verifying in your own region

Use the same endpoint the provider uses:

```bash
BASE=https://eu.openrouter.ai/api/v1

# How many models the region advertises
curl -s "$BASE/models" | jq '.data | length'

# Is a given ID advertised?
curl -s "$BASE/models" | jq -r '.data[].id' | grep -x 'openrouter/pareto-code'

# Does it answer?
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/chat/completions" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "model": "openrouter/pareto-code", "messages": [{ "role": "user", "content": "ok" }], "max_tokens": 4 }'
```

In OpenCode, remember that the model reference is `provider/modelID`, and some
model IDs already contain a provider prefix:

```bash
opencode run -m openrouter/openrouter/pareto-code "ok"
opencode run -m openrouter/openrouter/auto "ok"
```

## Further reading

- [OpenRouter: Routers](https://openrouter.ai/docs/guides/routing/routers), the
  index of all router modes, including those not covered here.
- [OpenRouter: In-Region Routing](https://openrouter.ai/docs/guides/features/in-region-routing),
  the rules behind regional guardrails and regional model lists.

## Scope

This page records behaviour observed against OpenRouter's in-region endpoints.
It is not a copy of official OpenRouter documentation, and it is not a
guarantee: the catalog and the router behaviour can change. The plugin's README
remains the reference for how filtering works.
