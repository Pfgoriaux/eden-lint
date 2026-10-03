# @eden/lint

Shared lint setup for eden projects:

- `biome.base.json`: Biome formatter and linter settings plus GritQL plugins from `biome/plugins/`.
- `oxlint.base.json`: Oxlint runs the vendored [anti-slop](anti-slop/UPSTREAM.md) rules plus `oxc/no-accumulating-spread`, with every other Oxlint rule off. Biome stays the formatter and main linter; Oxlint runs because anti-slop rules need its JS plugin API, which Biome lacks.
- `env/`: env-var checks: names against `env/registry.json`, no committed env files, and `.env.example` coverage.

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
| `eden-lint env [dir]` | env-var checks |

Two fix rounds are needed because anti-slop's `require-readable-spacing` autofix and the Biome formatter each change lines the other inspects.

## Env vars

One tracked `.env.example` lists every variable the project reads. Local values live in a gitignored `.env`. Production values live only in Coolify, so no `.env.production` file exists.

`eden-lint env` reports three rules:

| Rule | Reports |
|---|---|
| `naming` | a banned alias, with its canonical replacement |
| `env-file` | a real env file (`.env`, `.env.production`, `.env.local`, ...) that git tracks or does not ignore |
| `example` | a name read by code or by compose `${...}` interpolation that no `.env*.example` file lists, once per name; or a missing `.env.example` when the project reads env vars |

Commented lines such as `# OPTIONAL_FLAG=` in an example file count as listed. Names set by the runtime (`NODE_ENV`, `PORT`, `CI`, `GITHUB_*`, `COOLIFY_*`, and others in `providedByRuntime` in `env/registry.json`) are exempt from `example`.

Canonical names: `PROXY_URL`, `PROXY_URLS`, `DATABASE_URL`, `DATABASE_SCHEMA`, `REDIS_URL`. Each may take a role prefix: `CATALOG_IMPORTER_DATABASE_URL`, `VOYAGER_PROXY_URL`. `env/registry.json` maps banned aliases to their replacement, so `DB_URL` reports `DATABASE_URL` and `COMLINK_DB_SCHEMA` reports `COMLINK_DATABASE_SCHEMA`.

The check reads tracked and untracked, non-ignored files from `git ls-files`:

- `.env*.example`, `.env*.sample`, `.env*.template` (never `.env` itself)
- `compose*.yml` and `docker-compose*.yml`
- `Dockerfile*` and `*.sh`
- `process.env`, `Bun.env`, `import.meta.env` (dot and bracket access), and Python `os.environ` / `os.getenv` reads in JS, TS, and Python files

Symlinks are skipped, so a tracked `.env.example` that links to `.env` is never read.

A name in `env.allow` is exempt from every env rule. Paths under `env.ignorePaths` are not scanned. Both go in `.eden-lint.json` at the project root:

```json
{
  "env": {
    "allow": { "DATABASE_HOST": "Strapi reads split DATABASE_* settings" },
    "ignorePaths": ["test/fixtures/"]
  }
}
```

## Severities

A project can raise a `warn` rule to `error` in its own config.

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
