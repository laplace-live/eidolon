# The resampler

pipedog's `resampler-wasm` package at `ce8f8bc` (v0.10.0), vendored: rubato 5.0.1's windowed-sinc
resampler compiled to WebAssembly, the engine pipedog's transports and services resample with.

- `wasm/resampler.wasm` is pipedog's committed build, byte for byte (38,893 bytes, sha256
  `16a43a8ddedd5378cdfb2c26d8fc7b80044aab48e15c897f3dda21fc800c8ba4`). `wasm/LICENSE` is
  pipedog's BSD 2-Clause license, and `wasm/THIRD_PARTY_LICENSES.md` the licenses of every crate
  compiled into the module. The npm package ships the folder as `data/resampler/`.
- `rust/` is its source, unchanged. `engine.ts` is pipedog's wrapper over the module's exports,
  without the soxr-shaped facade pipedog's core used.
- `index.ts` replaces pipedog's loaders: it reads the module through `shippedPath`, never
  relative to the code, and compiles it synchronously on first use. pipedog's workerd entry and
  its base64 copy of the module are left out.

To rebuild the module from `rust/`, with the `wasm32-unknown-unknown` target and binaryen's
`wasm-opt`:

```sh
cargo build --manifest-path rust/Cargo.toml --release --target wasm32-unknown-unknown
wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
  --enable-mutable-globals --enable-multivalue --enable-reference-types \
  rust/target/wasm32-unknown-unknown/release/pipecat_resampler_wasm.wasm -o wasm/resampler.wasm
```
