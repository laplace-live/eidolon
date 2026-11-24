# PSD2Live's player and runtime

PSD2Live's web player and runtime at
[`f66ba4611d81154a35715c721539e912ad10d7f9`](https://github.com/tsunehimatoi/psd2live/tree/f66ba4611d81154a35715c721539e912ad10d7f9)
(release 3.8.4), both MIT, vendored to play the `.p2lrt` models a persona's owner makes in
PSD2Live. The editor itself is GPL-3.0 and none of it is here.

- `wasm/p2l_runtime.wasm` is PSD2Live's committed build of `runtime/`, byte for byte (629,677 bytes,
  sha256 `d8bbff52f27aebd40baca94139f9eca5af0f9d2a07c1c70fc5c15633121862a7`), the file every `web`
  export carries. It imports nothing. `wasm/LICENSE` is `runtime/LICENSE` and
  `wasm/THIRD_PARTY_LICENSES.md` the licenses of the crates compiled into it. The SDK's pack ships
  the folder as `dist/avatar/wasm/`, and `@laplace.live/eidolon` as `data/psd2live/`, where the
  local app's upload check reads it.
- `rig.ts` and `renderer.ts` are ported from the player,
  `targets/web/src/main/resources/io/github/psd2live/targets/web/p2l.js` (sha256
  `d4732ce620d7bf5cb37495f16a8129f8df2ca352ea40b27640dbdd49e771878d`), split into what runs without
  WebGL and what draws. Their methods keep upstream's order so a refresh diffs cleanly.

To refresh at a newer commit:

1. Copy `targets/web/src/main/resources/io/github/psd2live/targets/web/p2l_runtime.wasm` to
   `wasm/`, and note its sha256 here and wherever a test pins it (`git grep d8bbff52`).
2. Diff upstream's `p2l.js` between the two commits and port the change into `rig.ts` and
   `renderer.ts`, then put the new commit wherever the old one is named (`git grep f66ba46`): the
   headers, this README, the SDK's `THIRD_PARTY.md`, which its pack ships, AGENTS.md, the docs and
   a test.
3. Copy `runtime/LICENSE`, and refresh `wasm/THIRD_PARTY_LICENSES.md` from `runtime/Cargo.lock`.
4. Check `PSD2LIVE_ABI`, and the minimum the local app's upload check holds in
   `apps/bot/src/local/psd2live.ts`, against `runtime/include/p2l_runtime.h`.
