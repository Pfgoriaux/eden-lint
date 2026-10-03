# Vendored anti-slop

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`, MIT (`LICENSE` in this folder).

Copied from upstream `src/`: `index.ts`, `rules/`, `shared/`, `vendor/`. The `effect/` rule group is not copied because no eden project depends on Effect.

Local changes: none to rule source. Severities live in `../oxlint.base.json`.

## Updating

1. Clone upstream and diff `src/` between the commit above and the new revision.
2. Apply the diff to this folder, skipping `effect/`.
3. Run `pnpm build` and `pnpm check`, then record the new commit here.
