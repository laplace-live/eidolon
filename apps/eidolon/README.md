# Eidolon

Build a voice persona and call her from your browser, on your own computer: a setup wizard for
your Soniox, OpenRouter and Fish Audio keys, a studio for her prompt, voice, facts and stream
videos, a call page, and text chats that keep their history.

```bash
npx @laplace.live/eidolon
```

The terminal prints the link that signs your browser in, and opens it. `npx @laplace.live/eidolon
--help` lists the offline commands, which build a persona's knowledge from her facts and videos;
the web app runs them too.

It needs Node.js 20 or later, and brings its own Bun. Everything it keeps, settings and keys
included, is in `~/.laplace/eidolon` (or the folder `EIDOLON_HOME` names); it reads no `.env`.

## Platforms

LanceDB and ONNX Runtime, its native parts, decide where it runs: macOS on Apple silicon (with an
arm64 Node), and Linux with glibc on x64 or arm64. Intel Macs, musl Linux such as Alpine, and
Windows are not supported.

The first run downloads about 280 MB, mostly Bun, LanceDB and ONNX Runtime for your platform, and
the install takes about 750 MB on disk on a Mac and 900 MB on Linux.

On Linux x64, npm 11 also runs onnxruntime-node's install script, which downloads CUDA libraries
Eidolon never uses from NuGet, and fails the install when NuGet is out of reach. Skip it:

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npx @laplace.live/eidolon
```

## More

The source, the docs and how to run it from a checkout: https://github.com/laplace-live/eidolon

Eidolon is licensed under the GNU Affero General Public License, version 3 only. NOTICE and
THIRD_PARTY_NOTICES.md list what it includes from others.
