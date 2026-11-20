# Third-party notices

`@eidolon/assistant` ports parts of pi-mono, Mario Zechner's coding agent, under the MIT License in
`LICENSE-pi`. Each file whose header names pi-mono is ported from it, at the commit the header
names. Its MCP client (`src/mcp/`) ports pi's `packages/mcp` and its coding agent's MCP
extension, with the stdio transport alone: pi's OAuth, which adapts the MCP TypeScript SDK, isn't
ported. It runs on cross-spawn (MIT), diff (BSD-3-Clause), htmlparser2 (MIT), ignore (MIT),
minimatch (BlueOak-1.0.0), undici (MIT) and yaml (ISC), installed as packages with their own
notices.

## pi-mono

License: `MIT`  
Source: https://github.com/badlogic/pi-mono, commit `ac78a60`; the Windows parts of the shell,
bash, path and MCP stdio ports, commit `cb1205e`

```text
MIT License

Copyright (c) 2025 Mario Zechner

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
