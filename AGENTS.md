# @eden/lint

Shared Biome config, Biome GritQL plugins, vendored anti-slop Oxlint rules, and env-var naming checks for eden projects. See [README.md](README.md) for usage.

- `anti-slop/` is vendored upstream source. Keep rule changes out of it; set severities in `oxlint.base.json`. Update it with the procedure in [anti-slop/UPSTREAM.md](anti-slop/UPSTREAM.md).
- After changing anything in `anti-slop/`, run `pnpm build` and commit `dist/`. `pnpm check:dist` fails when they differ.
- Plugin paths in `biome.base.json` start with `./node_modules/@eden/lint/` because Biome resolves them from the consuming project root. This repo resolves them through its `"@eden/lint": "link:."` dev dependency.
- A new Biome plugin needs `biome/tests/fail/<name>.*` and `biome/tests/pass/<name>.*` fixtures; `scripts/test-biome-plugins.mjs` finds them by name.
- A new canonical env-var name or banned alias goes in `env/registry.json`, with a case in `env/test/check.test.mjs`.
- Before adding a rule to a base config, run it across eden projects and set `warn` when it fires widely.
- Run `pnpm check` before committing.
