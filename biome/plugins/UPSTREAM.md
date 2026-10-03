# Biome plugin sources

`no-emojis`, `no-empty-catch`, `no-inline-imports`, `no-inner-types`, `no-is-record`, and `pi-no-node-exec` come from [aliou/biome-plugins](https://github.com/aliou/biome-plugins), commit `7ef097d12fd8a20379dcc6781e948b55df3e19c4`, MIT. Fixtures in `../tests/` come from the same commit.

Differences from upstream:

- `no-emojis` and `no-inline-imports` report `warn`.
- `no-empty-catch` matches a catch block with no statements, so `break` and `continue` pass and comment-only blocks fail.
- `pi-no-node-exec` matches each import specifier, so imports with any number of names are checked.
