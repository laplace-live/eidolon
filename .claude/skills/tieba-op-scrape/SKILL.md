---
name: tieba-op-scrape
description: Scrape every post by the OP (楼主) of a Baidu Tieba thread (tieba.baidu.com/p/...) by floor order into a plain-text file, delivered via an in-page download button. Supports incremental resume — the highest OP floor scraped is saved to `.tieba-scrape-progress.txt` in the project root, and subsequent runs auto-resume from `last_floor + 1` when the user doesn't specify a starting 楼层. Uses Chrome DevTools MCP with heuristic DOM detection (no hardcoded class names or selectors), virtual-scroll batched accumulation, and a confirm-before-download handshake. Use when the user asks to scrape, extract, save, or download a 百度贴吧 thread, capture all OP posts as plain text, 抓取贴吧楼主全部内容, or resume a previous scrape.
---

# Tieba OP Scrape (heuristic, chrome-devtools mcp)

Scrape all posts by the thread starter (楼主 / OP) of a Baidu Tieba
thread — `https://tieba.baidu.com/p/<thread_id>` — by floor order into
a single plain-text file, delivered via a download button injected at
the top-left of the page. This skill is **heuristic-first**: it never
assumes specific class names or DOM selectors, because Tieba mutates
its CSS classes between deploys.

## FIRST: verify chrome-devtools MCP is available

Try calling `list_pages`. If the tool is missing, STOP — the
`chrome-devtools` MCP server is not configured. Ask the user to add it
to their MCP config:

```json
"chrome-devtools": {
  "type": "local",
  "command": ["npx", "-y", "chrome-devtools-mcp@latest"]
}
```

## Inputs needed from the user

- **Thread URL** (e.g. `https://tieba.baidu.com/p/10218214239`)
- **OP username** (e.g. `盆中菇`) — used to filter at the end
- **Starting floor 楼层** (optional, integer ≥ 1) — only OP posts with
  `floor >= startingFloor` are written to the output file. If the user
  doesn't supply it, look up `.tieba-scrape-progress.txt` (see
  **Progress tracking** below) and default to `last_floor + 1` for this
  thread. If neither input nor progress file is available, default to
  `1` (full scrape).

If the thread URL or OP username is missing, ask once, then proceed.
**Never ask about 楼层** — silently fall through input → progress file
→ 1.

## Tools used

All from the `chrome-devtools` MCP server:

| Need                          | Tool call                                       |
| ----------------------------- | ----------------------------------------------- |
| Find/open the thread tab      | `list_pages` → `select_page` or `navigate_page` |
| Wait for thread to render     | `wait_for(text: ["楼", "回复", "发表"])`        |
| Run all probing + scrolling   | `evaluate_script(function: "...")`              |
| Trigger the download (final)  | `evaluate_script` clicking the injected `<a>`   |

`evaluate_script` is the workhorse. It takes a JS function declaration
string and returns the function's JSON-serializable return value.

Two hard limits constrain every `evaluate_script` call (both bit us in
the existing selector-hardcoded variant of this scraper):

- **~45 s CDP timeout per call.** Scrolling must be batched.
- **~1500 char return-string truncation.** Never `return` full text.

## Core principle

不要假设任何 class 名或 DOM 选择器，全部通过探测和启发式判断动态确定。
网站会改 class 名，请用结构特征而非字符串匹配。

## Progress tracking

After every successful download confirmation, record the high-water
mark for this thread in `<project-root>/.tieba-scrape-progress.txt`.
On future runs against the same thread the skill resumes from
`last_floor + 1` without re-emitting already-captured posts.

**Location.** Project root. Path: `.tieba-scrape-progress.txt`. One
file per project, multiple threads share it. Hidden by convention —
the user may freely gitignore or commit it.

**Format.** Plain text. Tab-separated, one line per thread, with a
header comment. Lines starting with `#` are comments. Lookup key is
the thread ID (first column). Columns in order:
`thread_id` `<TAB>` `last_floor` `<TAB>` `op` `<TAB>` `updated_iso`
`<TAB>` `url`.

```
# tieba-scrape-progress (auto-managed by tieba-op-scrape skill)
# columns: thread_id<TAB>last_floor<TAB>op<TAB>updated_iso<TAB>url
10218214239	847	盆中菇	2026-05-19T07:55:00-07:00	https://tieba.baidu.com/p/10218214239
12345678	120	someuser	2026-05-15T10:30:00-07:00	https://tieba.baidu.com/p/12345678
```

**Semantics of `last_floor`.** The highest OP floor that has been
successfully scraped and downloaded for this thread, across all
historical runs. It is **monotonically non-decreasing** — a partial
rescrape with a user-supplied lower 楼层 does not regress it. To truly
reset for a thread, delete its line (or the whole file).

**Read failures are non-fatal.** Missing file, malformed line, or no
matching thread ID → fall back to starting floor `1`. Never block the
scrape on progress-file errors.

## Execution constraints (verbatim from spec)

**定位真正的滚动容器（不要假设是 window）。** 探测所有元素中
`overflowY` 为 `auto` / `scroll` 且 `scrollHeight > clientHeight + 一定阈值`
的节点，挑选其中尺寸最大、且包含最多重复评论结构的那个作为主滚动
容器。如果 window 本身可滚动也可以用 window。

**识别"一条评论"的重复单元。** 用以下启发式找到重复的评论卡片节点：

- 在滚动容器内，找出现次数最多、且每个实例同时包含"用户名样式短文本
  + 较长正文文本 + 楼层/时间元数据"三类特征的元素模式
- 楼层元数据的特征：包含 `第N楼` 或形如 `YYYY-MM-DD` / `MM-DD` /
  `X小时前` / `X分钟前` 的字符串
- 用户名的特征：短文本（通常 < 20 字符）且在卡片头部，附近常有头像
  `<img>`
- 正文的特征：卡片内除上述元数据/用户名外、字符数最多的那个子节点的
  `innerText`

**正文提取要排除楼中楼。** 一条主楼回复下面常嵌套楼中楼子回复，它们
也匹配评论结构。正文应取"卡片内最外层、专门承载本楼正文的那个子节点"
——通常是字符最多但不包含任何嵌套评论卡片的最小子节点。可用如下
启发式：在卡片内找所有候选子节点，剔除其后代里仍含有"用户名+元数据"
组合的，剩下里字符最多的那个就是正文。

**元数据解析。** 从卡片中提取首个匹配 `第(\d+)楼` 的字符串作为楼层号；
提取最像时间戳的字符串作为发帖时间；用户名取卡片头部第一个短文本
节点。

**跨调用累计。** 用 `window.__collected = window.__collected || new Map()`，
key 为正文前 100 字符 + 楼层号，跨多次 `evaluate_script` 调用去重累计。

**不要点"只看楼主"按钮**（在百度贴吧上常常无效）。直接抓全部，最后按
`name === '<楼主用户名>'` 过滤。

**分批滚动以避免 45 秒 CDP 超时。** 每次 `evaluate_script` 调用只跑
30–40 步滚动（每步 `scrollTop += 700`，`await sleep(200ms)`，每步后
调用一次采集函数）。重复调用直到：**连续两次累计 size 不变** 且
**`scrollTop + clientHeight >= scrollHeight - 阈值`**。注意虚拟化容器
的 scrollHeight 会随滚动动态增长，初始值不可信。

**结果整理。** 过滤楼主、按楼层号数值排序、去重，组装成
`第N楼: 正文（换行用 / 替换）` 一行一条。

**交付方式。** `evaluate_script` 单次输出约 1500 字符就会被截断，不要
尝试把全文 return。直接用 `Blob` + `<a download>` 注入页面左上角，
生成显眼的下载按钮，文件名 `<楼主用户名>_<帖子名称>.txt`。下载是需
显式授权的操作，按钮就位后告诉用户并等用户说 `yes` 再触发。

**沟通简洁。** 不要中间截图、不要抽样让用户确认、不要展示选择器探测
过程。最后只汇报：总条数 / 总字符数 / 楼层范围 / 缺失楼层数 /
下载按钮已就位。

**容错。** 如果某一步启发式找不到唯一答案（例如多个候选滚动容器、
多个候选正文节点），打印候选清单并选择其中"包含评论数量最多 / 文本
字符最多"的那个继续，不要停下来问用户。

## Standard workflow

Map the constraints above onto these stages. Each browser stage is one
or more `evaluate_script` calls; do not interleave with screenshots or
snapshots. **Stage 0** and **Stage E** run entirely on the agent side
(project file I/O, no browser).

### Stage 0 — Resolve starting floor (no browser)

Before opening the page:

1. Parse the thread ID from the URL — the digits after `/p/`.
2. Determine `startingFloor`:
   - If the user explicitly supplied a 楼层, use it (clamped to ≥ 1).
   - Else read `<project-root>/.tieba-scrape-progress.txt`. If a line's
     first tab-separated column equals this thread ID, parse its
     `last_floor` and use `last_floor + 1`.
   - Else default to `1`.
3. Hold `startingFloor` for Stage A to stash on `window`. Don't
   announce it mid-flow — surface it only in Stage D's final summary.

If the progress file does not exist, do nothing. File
creation/append is Stage E's job.

### Stage A — open page + probe + bootstrap (1 call)

1. `list_pages`. If the thread URL is already open, `select_page`.
   Otherwise `navigate_page(type: "url", url: <thread_url>)` and then
   `wait_for(text: ["楼", "回复"])`.
2. One `evaluate_script` call that does everything below in JS:
   - Probe the scroll container (constraint 1). Score every element by
     `(clientWidth * clientHeight) * <repeating-card count inside it>`;
     pick the max. Stash on `window.__container`.
   - Probe the repeating-card pattern (constraint 2). Group elements by
     a structural fingerprint (e.g. tagName + sorted class bag + child
     tagName signature, with class strings **kept abstract** — count
     classes, don't match specific names). Pick the largest group whose
     representative satisfies the {short-name-text + long-body-text +
     floor-or-timestamp metadata} predicate. Stash the fingerprint on
     `window.__cardFp` so later calls can re-query.
   - Extract the thread title heuristically (likely the shortest
     visible `<h1>`/`<h2>`/`<h3>` near the container top, or fall back
     to `document.title`). Stash on `window.__threadTitle`.
   - `window.__collected = new Map()` (reset on first call).
   - `window.__startingFloor = <startingFloor from Stage 0>` (integer
     ≥ 1; default 1). Stage C reads this to gate the output.
   - Return `{containerOk, candidates: <n>, cards: <n>, title: <string>, startingFloor: <int>}`.
     If `containerOk === false` or `cards < 3`, **return the candidate
     list** (truncated to top 5) per constraint 11 and pick the
     best-by-card-count automatically on the next call; do not stop.

### Stage B — scroll + accumulate (N calls)

Each call runs **30–40 scroll steps**, capturing on every step.
Sketch (adapt the heuristic helpers to whatever Stage A found):

```js
async () => {
  const c = window.__container;
  const matchFp = (el) => /* re-detect using window.__cardFp */;
  const findCards = () => Array.from(c.querySelectorAll('*')).filter(matchFp);
  const extract = (card) => {
    // floor: first descendant whose innerText matches /第(\d+)楼/
    // body:  largest-by-chars descendant whose subtree has NO other
    //        element that itself contains a name+metadata combo
    //        (this is what excludes nested 楼中楼)
    // name:  short (<20ch) text node at card head, often adjacent <img>
    // returns {name, floor, text} or null
  };
  for (let i = 0; i < 35; i++) {
    c.scrollTop += 700;
    await new Promise(r => setTimeout(r, 200));
    for (const card of findCards()) {
      const rec = extract(card);
      if (!rec || !rec.floor) continue;
      const key = rec.text.slice(0, 100) + '||' + rec.floor;
      if (!window.__collected.has(key)) window.__collected.set(key, rec);
    }
  }
  return {
    size: window.__collected.size,
    scrollTop: c.scrollTop,
    scrollHeight: c.scrollHeight,
    clientHeight: c.clientHeight,
    atBottom: (c.scrollTop + c.clientHeight) >= (c.scrollHeight - 200),
  };
}
```

Repeat the call until **`size` is unchanged across two consecutive
calls** AND **`atBottom === true`**. The 200-px tail is the threshold
that absorbs Tieba's lazy "已加载全部评论" marker. Do not stop early on
the first `atBottom` — the virtualized `scrollHeight` is unreliable
until the tail loads.

### Stage C — filter + sort + assemble + inject button (1 call)

```js
() => {
  const OP = '<楼主用户名>';
  const startingFloor = Math.max(1, (window.__startingFloor | 0) || 1);
  const all = Array.from(window.__collected.values());

  // Capture-integrity metric: gaps in the FULL set of top-level floors we
  // extracted (OP + non-OP combined). Non-OP floors are NOT "missing" —
  // they belong to other users. What we actually want to detect is whether
  // scrolling skipped any top-level cards entirely. Compute `missing` BEFORE
  // the OP filter, otherwise every non-OP reply between two OP posts gets
  // flagged as missing and the metric becomes meaningless.
  const allFloors = all
    .map(p => parseInt((p.floor.match(/第(\d+)楼/) || [0, 0])[1], 10))
    .filter(n => n > 0);
  const capMin = allFloors.length ? Math.min(...allFloors) : 0;
  const capMax = allFloors.length ? Math.max(...allFloors) : 0;
  const capSet = new Set(allFloors);
  const missing = [];
  for (let i = capMin; i <= capMax; i++) if (!capSet.has(i)) missing.push(i);

  // OP-only assembly. Compute `newLastFloor` over the FULL OP set (BEFORE
  // applying the startingFloor gate) so the progress file records the
  // actual high-water mark even when startingFloor truncates the output.
  const op = all.filter(p => p.name === OP);
  const seen = new Set(), unique = [];
  for (const p of op) if (!seen.has(p.text)) { seen.add(p.text); unique.push(p); }
  const allOpRows = unique
    .map(p => ({...p, n: parseInt((p.floor.match(/第(\d+)楼/) || [0, 0])[1], 10) || 0}))
    .filter(p => p.n > 0)
    .sort((a, b) => a.n - b.n);
  const newLastFloor = allOpRows.length ? allOpRows[allOpRows.length - 1].n : 0;

  // Apply the startingFloor gate for output assembly:
  const rows = allOpRows.filter(r => r.n >= startingFloor);
  const opFloors = rows.map(r => r.n);
  const min = opFloors[0] || 0, max = opFloors[opFloors.length - 1] || 0;
  const txt = rows.map(r => `第${r.n}楼: ${r.text.replace(/\n/g, ' / ')}`).join('\n');

  const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim() || '帖子';
  const suffix = startingFloor > 1 ? `_第${startingFloor}楼起` : '';
  const old = document.getElementById('__tieba_dl'); if (old) old.remove();
  const blob = new Blob([txt], {type: 'text/plain;charset=utf-8'});
  const a = document.createElement('a');
  a.id = '__tieba_dl';
  a.href = URL.createObjectURL(blob);
  a.download = `${safe(OP)}_${safe(window.__threadTitle)}${suffix}.txt`;
  a.textContent = '⬇ 下载楼主全部正文';
  a.style.cssText = 'position:fixed;top:20px;left:20px;z-index:2147483647;background:#ffeb3b;color:#000;padding:12px 16px;border:2px solid #d32f2f;border-radius:6px;font:600 14px/1 sans-serif;text-decoration:none;box-shadow:0 4px 12px rgba(0,0,0,.25);cursor:pointer;';
  document.body.appendChild(a);

  return {
    count: rows.length,                  // OP posts written to file (after startingFloor gate)
    chars: txt.length,
    floorRange: [min, max],              // OP floor span in this run's output
    startingFloor,                       // gate used for this run
    newLastFloor,                        // highest OP floor across full collected set — Stage E saves this
    capturedCount: all.length,           // total top-level cards captured
    capturedRange: [capMin, capMax],     // span of all captured floors
    missingCount: missing.length,        // gaps inside capturedRange — capture failures
    sampleMissing: missing.slice(0, 10),
    filename: a.download,
    buttonInjected: true,
  };
}
```

### Stage D — report, wait for `yes`, then trigger

Per constraint 9, the download requires explicit user authorization.
Report to the user (extends constraint 10 with resume info when
relevant).

When `startingFloor === 1` (full scrape):

> 总条数: N | 总字符数: C | 楼层范围: [min..max] | 缺失楼层数: M | 下载按钮已就位

When `startingFloor > 1` (resumed scrape):

> 起始楼层: S | 本次新增: N | 总字符数: C | 楼层范围: [min..max] | 缺失楼层数: M | 下载按钮已就位

Then **stop** and wait for the user to reply `yes` (or equivalent).
Only after confirmation, fire one final `evaluate_script`:

```js
() => { const a = document.getElementById('__tieba_dl'); if (a) a.click(); return 'ok'; }
```

### Stage E — Update progress file (no browser)

After the user's `yes` and the click fires, write the new high-water
mark to `<project-root>/.tieba-scrape-progress.txt`.

1. Read `.tieba-scrape-progress.txt` if it exists. Otherwise prepare
   a fresh file starting with the two-line header from **Progress
   tracking**.
2. Locate the line whose first tab-separated column equals this
   thread's ID. Replace its `last_floor`, `op`, `updated_iso`, `url`
   columns. If no such line exists, append a new one.
3. Compute the new `last_floor` as
   `max(prior last_floor for this thread, newLastFloor from Stage C)`.
   Monotonic semantics — a user-initiated partial rescrape with a
   lower 楼层 does **not** regress the resume point.
4. If `newLastFloor === 0` (no OP posts captured at all), **skip the
   update**. The most likely cause is a heuristic misfire; surface it
   to the user instead of poisoning the progress file.
5. `updated_iso` is the current ISO-8601 timestamp with timezone
   offset (e.g. `2026-05-19T07:55:00-07:00`).
6. Preserve every other thread's line verbatim. Don't sort or
   re-canonicalize the file.
7. This is a plain-text write by the agent against the project
   working tree — no browser, no `evaluate_script`.

## Heuristic helpers — implementation notes

Some details that bit the selector-hardcoded variant of this scraper.
Encode these inside the `extract` / `findCards` helpers, not as
top-level assumptions:

- **Body-vs-楼中楼 disambiguation.** Inside a card, do a tree walk:
  for every descendant `d`, compute `chars(d)` and
  `hasInnerCard(d) = any descendant of d looks like a card`. The body
  is `argmax chars(d) where !hasInnerCard(d)`. This naturally rejects
  the outer `card` itself (which contains nested 楼中楼) and zeroes in
  on the prose container.
- **Floor pattern is the strongest signal.** Cards without
  `/第(\d+)楼/` in their metadata are almost always 楼中楼 sub-replies
  — skip them entirely.
- **Username extraction.** Walk up from the body element a few levels
  and look for the first short (`< 20` char) text node whose parent
  has a sibling `<img>` (avatar). Falling back to "the first short
  text node in the card" is acceptable if the avatar heuristic misses.
- **scrollHeight growth.** Capture `scrollHeight` at the START of each
  Stage B call and again at the END. If the END value is bigger, you
  are not at the bottom even if `atBottom` evaluated true mid-call;
  schedule another Stage B call.
- **Card fingerprint stability.** Re-detect cards on every step inside
  Stage B — Tieba sometimes re-mounts nodes when scrolling fast.
  Caching elements across steps will lose half your captures.

## Validation (before reporting to user)

In Stage C's return value, sanity-check:

- For **full scrapes** (`startingFloor === 1`): `count` is plausibly
  in line with the thread's claimed reply total for OP (Tieba
  sometimes deletes a few floors; small gap is fine). For **resumed
  scrapes** (`startingFloor > 1`): `count` represents only NEW posts
  since `startingFloor` — don't compare against the thread total,
  just confirm it's ≥ 0 and not absurdly large.
- `floorRange[0]` is reasonable. For full scrapes, Tieba's first OP
  floor is usually #1 or #2 (depending on layout — the very first
  "floor" may be the thread body itself). For resumed scrapes,
  `floorRange[0] >= startingFloor` (or `[0, 0]` if no new posts).
- `missingCount / capturedCount` is small. **Use `capturedCount`, not
  `count`, as the denominator.** `missingCount` measures gaps inside the
  full captured floor range (OP + non-OP combined), so it's a capture-
  integrity signal — were any top-level cards skipped during scrolling?
  Dividing by `count` (OP-only posts) is wrong: in any thread where the
  OP only posts on a fraction of floors (the common case), most floors
  in `[opFloorRange[0]..opFloorRange[1]]` belong to other users and were
  never expected to appear in OP output. Computing missing on the OP-
  filtered set would flag those non-OP replies as failures and force
  unnecessary Stage B re-runs against alternative scroll containers.

If `newLastFloor` is suspiciously low for a full scrape (e.g. < 10
when the thread claims hundreds), the heuristic likely picked the
wrong scroll container or wrong card fingerprint. Per constraint 11,
fall back to the next-best candidate and re-run Stage B; do **not**
ask the user. Note: use `newLastFloor` (not `count`) as the trigger
because `count` is post-filter and may legitimately be 0 on a resumed
scrape where no new OP posts exist.

## Communication etiquette (constraint 10)

- No screenshots between scrolls.
- No "确认一下选择器是这个吗" check-ins.
- No selector / fingerprint dumps unless Stage A's `containerOk` is
  false or `cards < 3`.
- No "I see a progress file, resume from floor X?" check-ins —
  Stage 0 picks the starting floor silently. The user finds out from
  Stage D's summary, where `起始楼层: S` makes it explicit.
- Final message format: see **Stage D** — two variants exist
  (`startingFloor === 1` vs `startingFloor > 1`). Then wait for the
  user's `yes` before the final download click.
- After the click, Stage E updates `.tieba-scrape-progress.txt`
  silently. No need to announce the file write unless the user asks
  or unless step 4 of Stage E suppressed the update (in which case
  surface why).
