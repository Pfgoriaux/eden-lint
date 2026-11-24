# @eden/lint

Shared lint setup for eden projects:

- `biome.base.json`: Biome formatter and linter settings plus GritQL plugins from `biome/plugins/`.
- `oxlint.base.json`: Oxlint runs the vendored [anti-slop](anti-slop/UPSTREAM.md) rules plus `oxc/no-accumulating-spread`, with every other Oxlint rule off. Biome stays the formatter and main linter; Oxlint runs because anti-slop rules need its JS plugin API, which Biome lacks.
- `env/`: env-var checks: names against `env/registry.json`, no committed env files, and `.env.example` coverage.
- `ratchet/`: per-rule warning caps that may only go down (`eden-lint ratchet`).
- `ledger/`: the `.antislop.jsonl` ledger of review findings; entries with a `pattern` are enforced by `eden-lint ledger check`.

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
| `eden-lint ratchet [--init] [--update] [--config <path>]` | compare per-rule finding counts with the caps in `lint-ratchet.json` |
| `eden-lint ledger <list\|add\|import\|activate\|check\|promote\|close> [flags]` | review-finding ledger in `.antislop.jsonl`; `check` enforces `pattern` entries |

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

## Ratchet

`eden-lint ratchet` runs Oxlint and Biome in their JSON formats, counts findings per Oxlint rule code and Biome category, and compares the counts with the caps in `lint-ratchet.json` at the project root:

```json
{
  "oxlint": { "anti-slop(no-runtime-typeof)": 2 },
  "biome": { "lint/suspicious/noExplicitAny": 0 }
}
```

Warnings and errors both count toward a rule's count. A rule that is not listed has cap 0. The command exits 1 when any rule exceeds its cap or when any diagnostic is error-level (Biome `fatal` counts as error-level), whatever the caps say. When `lint-ratchet.json` is missing, every cap is 0 and the command says so.

Adopt it with `eden-lint ratchet --init`, which writes the current counts as caps when `lint-ratchet.json` does not exist; it exits 1 if the file exists or when error-level diagnostics exist.

`--update` writes the current counts as the new caps, but never raises one: a rule that is not listed gets cap 0, rules whose count dropped get the lower cap, and `--update` exits 1 when a current count is above an existing cap or when any diagnostic is error-level, so a regression cannot be hidden behind a higher cap. `--config <path>` reads and writes a different file.

## Ledger

`eden-lint ledger` keeps review findings in `.antislop.jsonl` at the project root, one JSON object per line:

```json
{
  "id": "1732450000000-9f2c",
  "text": "Do not spawn a shell for a fixed argv; pass an args array to spawnSync",
  "tag": "safety",
  "severity": "major",
  "pattern": "spawnSync\\([^,]+,\\s*\\{[^}]*shell:\\s*true",
  "glob": "**/*.{ts,tsx,js,mjs,mts}",
  "prescription": "Pass an args array to spawnSync.",
  "source": "123",
  "state": "open",
  "createdAt": "2025-11-24T10:00:00.000Z"
}
```

- `tag`: `architecture`, `tests`, `api`, `docs`, `naming`, `style`, `safety`, or `other`.
- `severity`: `minor` or `major`.
- `pattern`: optional JS regex source, tested line by line on the files matching `glob` (default `**/*.{ts,tsx,js,mjs,mts}`), case-insensitively; a leading `(?-i)` turns that off.
- `prescription`: what to do instead. `source`: the PR number, review, or session id the finding came from.
- `state`: `open`, `promoted` (with `promotedTo` set to the rule id), or `closed`.
- `reason`: optional, set by `close`.

`list`, `check`, `import`, `activate`, `promote`, and `close` validate every destination line, including superseded entries. A malformed line, missing `id`, or invalid entry makes them exit 1 with a `file:line: message` report. `list --from` validates only the external file; `add` validates only the proposed entry.

Subcommands:

| Subcommand | Effect |
|---|---|
| `add --text "..." --tag <tag> [--severity minor\|major] [--pattern <regex>] [--glob <glob>] [--prescription "..."] [--source "..."]` | appends an `open` entry; refuses unknown tags or severities and patterns that do not compile |
| `list [--state open\|promoted\|closed] [--tag <tag>]` | prints id, state, tag, severity, text (first 100 chars), and `pattern` when present |
| `list --from <absolute-ledger-path>` | validates and lists external captures without writing or requiring a matching repository; cannot combine with state/tag filters |
| `import --from <absolute-ledger-path> --id <entry-id>` | imports one selected capture as an unenforced open entry; appends nothing if the ID already exists in any state |
| `activate --id <entry-id> --pattern <approved-regex> --glob <approved-glob>` | appends an updated open entry with the operator's explicit, nonempty pattern and glob; preserves provenance |
| `check` | reports every pattern match as `path:line: <id> <text>`, exits 1 on any match; enforces only `open` entries and prints the count of open entries without a pattern as unenforced |
| `promote --id <id> --to <rule id>` | appends a copy with `state: promoted` and `promotedTo` set |
| `close --id <id> [--reason "..."]` | appends a copy with `state: closed` |

`promote` and `close` append rather than rewrite; `list` shows the latest state per id.

`check` scans tracked and untracked files that git does not ignore, and skips paths that no longer exist and symlinks. Outside a git repo, it walks the tree recursively, skipping `node_modules`, `dist`, `.git`, and symlinks.

### External review captures

Import and activation run only at the repository top level and refuse symlinked destination ledgers. Repository identity is the lowercase SHA-256 of the UTF-8 real Git common-directory path. Linked worktrees share this identity; another clone does not. Import requires the capture's `repoKey` to match. Activation also checks this identity for imported entries.

External JSONL records have exactly these fields; `prescription` is optional:

```ts
{
  captureVersion: 1,
  id: string,
  createdAt: string,
  source: "pr_review",
  finding: {
    section: "findings" | "slop",
    path: string,
    line: number,
    text: string,
    severity: "blocker" | "major" | "minor",
    prescription?: string
  },
  provenance: {
    repoKey: string,
    reviewedHead: string,
    diffSha256: string,
    verification: "model-verified"
  }
}
```

`createdAt` uses an RFC3339 timestamp with uppercase `T` and `Z` or a numeric offset, and up to nine fractional digits. Hashes use lowercase hex; `reviewedHead` is a 40- or 64-character Git object ID. Paths must be relative POSIX paths without backslashes, controls, empty components, `.` or `..`; lines are positive safe integers. Limits are 8 KiB for text, 4 KiB for prescription, 1 KiB for path, and 16 KiB per serialized record, measured in UTF-8 bytes.

Text is normalized with NFC, trimmed, and whitespace-collapsed. The ID must equal the lowercase SHA-256 of UTF-8 JSON for:

```js
[1, repoKey, reviewedHead, diffSha256, section, path, line, normalizedText]
```

The entire external file is validated before import. Identical normalized records collapse by ID; conflicting payloads fail. Extra fields, including patterns, globs, ledger tags/states, and `[decision]` text or prescriptions are rejected.

Lint constructs the final entry: Findings become `safety`, Slop becomes `style`, and `blocker` becomes `major`. It copies the ID, normalized text, timestamp, prescription, source, capture version, and provenance, adding section/path/line to provenance. Imports start `open` without a pattern or glob. Only explicit activation enables enforcement. Reimport never replaces an active, closed, or promoted entry.

Run all ledger mutations serially, including import, activation, add, close, and promote. They must not run concurrently; the ledger provides no cross-process transaction guarantee.

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

`pnpm check` runs the repo's own lint, the ratchet and ledger checks, every anti-slop RuleTester suite, the Biome plugin fixtures, the env tests, `tsc`, and a check that `dist/` matches `pnpm build`. `dist/` is committed because Node does not strip TypeScript types under `node_modules`, so consumers load compiled JS.
