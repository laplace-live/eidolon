# Third-party notices

`@laplace.live/eidolon-sdk/avatar` plays PSD2Live models with PSD2Live's web player and runtime,
under the MIT License in `LICENSE-psd2live`. PSD2Live's editor is GPL-3.0, and none of it is here.

- `src/avatar/psd2live/rig.ts` and `src/avatar/psd2live/renderer.ts` are ported from its web player,
  `targets/web/src/main/resources/io/github/psd2live/targets/web/p2l.js`, and keep its copyright
  header. In the npm package, `dist/avatar/index.js` includes them.
- `src/avatar/psd2live/wasm/p2l_runtime.wasm` is its runtime's WebAssembly build, unchanged, with
  `LICENSE` and the licenses of the crates compiled into it (`THIRD_PARTY_LICENSES.md`) beside it.
  The npm package ships the folder as `dist/avatar/wasm/`.

## PSD2Live

License: `MIT`  
Source: https://github.com/tsunehimatoi/psd2live, commit `f66ba4611d81154a35715c721539e912ad10d7f9`

```text
MIT License

Copyright (c) 2026 PSD2Live contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
