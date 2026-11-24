# The test rig

`tml.p2lrt` is the `tml` character from
[psd2live-examples](https://github.com/tsunehimatoi/psd2live-examples) (case `tml`, archive
`tml-1.0.0.zip`, sha256 `f6c98e308e4419d58328e0ced5b703b4ee0e790424ae503f2b0d6d5ad7620a66`), which
its authors dedicate to the public domain under CC0 1.0. It was generated and exported by
PSD2Live 3.8.4 through its MCP operations, as its editor does: `project_import_psd` of
`tml/psd-input/tml.psd`, `atlas_set_budget` with `page_size` 1024, then `project_export_target`
to `p2lrt` with `compress` and `zstd`.

- 3,471,396 bytes, sha256 `59c68b11c223d31828261d3420e015c091ce29dc29e23072e71b93c6f283ed81`.
- An editor export: its clip ids are `modifier:m32:…` to `modifier:m36:…` while their names and
  groups are `Idle`, `Blink`, `Nod`, `Shake` and `Talk`; six 1024² texture pages; zstd-compressed
  chunks.
- Seven expressions (`smile`, `sad`, `angry`, `surprised`, `shy`, `sleepy`, `gloom`), hit areas
  `HitAreaHead` and `HitAreaBody`, a 2048² canvas.

It lives under `apps/bot/test/local/`, which the production image leaves out; the SDK's tests read
it by path.
