# Vendored anti-slop

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`, MIT (`LICENSE` in this folder).

This folder holds upstream `src/index.ts`, `src/rules/`, `src/shared/`, and `src/vendor/`, unmodified. Upstream's `src/effect/` rule group is not included. Severities live in `../oxlint.base.json`.

## Updating

1. Clone upstream and diff `src/` between the commit above and the new revision.
2. Apply the diff to this folder, skipping `effect/`.
3. Run `pnpm build` and `pnpm check`, then record the new commit here.
