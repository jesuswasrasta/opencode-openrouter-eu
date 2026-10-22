# Changelog

## 0.1.0 - 2026-10-22

- First release.
- Filters the OpenRouter model registry using the catalog returned by the
  configured in-region endpoint (`https://eu.openrouter.ai/api/v1` by default).
- Disk cache with TTL, one retry, stale-cache fallback and configurable
  fail-open / fail-closed policy.
- Inert when the provider points at the global OpenRouter endpoint, or when the
  provider endpoint and the catalog endpoint disagree.
- Optional plugin config at `~/.config/opencode/openrouter-eu.json`.
