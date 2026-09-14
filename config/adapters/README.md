# Adapter Configs

Each `.json` file describes one adapter. The registry in
`src/core/registry.ts` loads all files from this directory at startup.

## Format

```json
{
  "id": "railway",
  "enabled": true,
  "credentialsSource": "env",
  "priority": 1,
  "credentials": { "source": "env", "prefix": "RAILWAY_" }
}
```

## Fields

- **id** - must match a factory registered via `registry.registerFactory()`.
- **enabled** - if `false`, the adapter is loaded but not instantiated.
- **credentialsSource** - `env`, `file`, or `inline`. Informational hint.
- **priority** - lower number = higher priority.
- **credentials** - passed to `adapter.init()`.

## Adding an adapter

1. Create `config/adapters/<id>.json`.
2. Register the factory in `src/index.ts`.
3. Implement `MarketplaceAdapter` (or extend `HttpPollAdapter`).
