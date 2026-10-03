# @eden/lint

Shared lint setup for eden projects:

- `biome.base.json`: Biome formatter and linter settings plus GritQL plugins from `biome/plugins/`.
- `oxlint.base.json`: Oxlint runs only the vendored [anti-slop](anti-slop/UPSTREAM.md) rules. Biome stays the formatter and main linter; Oxlint runs because anti-slop rules need its JS plugin API, which Biome lacks.
- `env/`: env-var naming check against `env/registry.json`.

## Install in a project

```bash
pnpm add -D github:Pfgoriaux/eden-lint#v0.1.0 @biomejs/biome@2.5.15
```

`biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.15/schema.json",
  "extends": ["@eden/lint/biome"]
}
```

Biome resolves plugin paths from the project root, so `biome.json` must sit next to `node_modules/`.

`package.json` scripts:

```json
{
  "lint": "eden-lint check",
  "lint:fix": "eden-lint fix"
}
```

Project overrides go in the project's `biome.json` (Biome merges them over the base) or in a project `.oxlintrc.json`:

```json
{
  "extends": ["./node_modules/@eden/lint/oxlint.base.json"],
  "rules": { "anti-slop/no-runtime-typeof": "error" }
}
```

## Commands

| Command | Runs |
|---|---|
| `eden-lint check` | `biome check .`, Oxlint with anti-slop, env check |
| `eden-lint fix` | Oxlint `--fix` and `biome check --write`, twice, then `check` |
| `eden-lint biome [args]` | `biome check` |
| `eden-lint oxlint [args]` | Oxlint with the project `.oxlintrc.json`, or `oxlint.base.json` |
| `eden-lint env [dir]` | env-var naming check |

Two fix rounds are needed because anti-slop's `require-readable-spacing` autofix and the Biome formatter each change lines the other inspects.

## Env-var names

Canonical names: `PROXY_URL`, `PROXY_URLS`, `DATABASE_URL`, `DATABASE_SCHEMA`, `REDIS_URL`. Each may take a role prefix: `CATALOG_IMPORTER_DATABASE_URL`, `VOYAGER_PROXY_URL`. `env/registry.json` maps banned aliases to their replacement, so `DB_URL` reports `DATABASE_URL` and `COMLINK_DB_SCHEMA` reports `COMLINK_DATABASE_SCHEMA`.

The check reads tracked and untracked, non-ignored files from `git ls-files`:

- `.env*.example`, `.env*.sample`, `.env*.template` (never `.env` itself)
- `compose*.yml` and `docker-compose*.yml`
- `Dockerfile*` and `*.sh`
- `process.env`, `Bun.env`, `import.meta.env`, and Python `os.environ` / `os.getenv` reads in JS, TS, and Python files

Exceptions go in `.eden-lint.json` at the project root:

```json
{
  "env": {
    "allow": { "DATABASE_HOST": "Strapi reads split DATABASE_* settings" },
    "ignorePaths": ["test/fixtures/"]
  }
}
```

## Severities

Rules that fire hundreds of times across eden today ship as `warn`. Projects raise them to `error` once clean.

| Level | Rules |
|---|---|
| error | anti-slop: `no-array-filter-map`, `no-reduce-accumulator-copy`, `no-chained-type-assertions`, `no-conditional-empty-object-spread`, `no-module-mocking`, `no-object-parameters`, `no-reflect-apply`, `no-reflect-get`, `no-shape-in-symbol-names`, `no-unknown-returns`, `no-unknown-type-aliases`, `no-widen-then-assert`, `require-readable-spacing`; `oxc/no-accumulating-spread`; Biome plugins `no-empty-catch`, `no-inner-types`, `no-is-record`; Biome `noExplicitAny` |
| warn | anti-slop: `require-safety-comment-for-type-assertion`, `no-unsafe-dictionary-type`, `no-runtime-typeof`, `no-unknown-parameters`, `no-known-value-widening`; Biome plugins `no-emojis`, `no-inline-imports`; Biome `noExcessiveCognitiveComplexity` |

`biome/plugins/pi-no-node-exec.grit` is not in the base. Pi extension repos add it in their own `biome.json`:

```json
{ "plugins": ["./node_modules/@eden/lint/biome/plugins/pi-no-node-exec.grit"] }
```

## Development

```bash
pnpm install
pnpm check
```

`pnpm check` runs the repo's own lint, every anti-slop RuleTester suite, the Biome plugin fixtures, the env tests, `tsc`, and a check that `dist/` matches `pnpm build`. `dist/` is committed because Node does not strip TypeScript types under `node_modules`, so consumers load compiled JS.
