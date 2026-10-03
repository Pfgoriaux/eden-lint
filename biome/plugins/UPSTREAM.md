# Biome plugin sources

`no-emojis`, `no-empty-catch`, `no-inline-imports`, `no-inner-types`, `no-is-record`, and `pi-no-node-exec` come from [aliou/biome-plugins](https://github.com/aliou/biome-plugins), commit `7ef097d12fd8a20379dcc6781e948b55df3e19c4`, MIT. Fixtures in `../tests/` come from the same commit.

Local changes:

- `no-emojis` and `no-inline-imports` report `warn` instead of `error`.
- `no-empty-catch` states that a comment alone does not satisfy the rule.
- Files are formatted by Biome.
