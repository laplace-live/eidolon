# Handover: Per-viewer Mem0 admin endpoints

**Audience:** frontend engineer wiring up a "manage what the bot remembers about
me" surface in the `laplace-eidolon` web client.
**Scope:** two HTTP endpoints — list + bulk-delete — that let a logged-in
viewer inspect and wipe the long-term memories Mem0 has stored under their
Bilibili UID.

This is a frontend-only task as far as wiring up UI; the backend is already
exposing the endpoints.

---

## TL;DR

```ts
// 1. Show the user what's stored.
const list = await fetch("/api/memories", {
  headers: { Authorization: `Bearer ${loginSyncToken}` },
}).then((r) => r.json());
// → { user_id, uname, count, memories: [{ id, memory, created_at, ... }] }

// 2. Wipe everything (after a confirmation dialog).
await fetch("/api/memories/forget", {
  method: "POST",
  headers: { Authorization: `Bearer ${loginSyncToken}` },
});
// → { ok: true, user_id }

// 3. If the user is mid-call, disconnect the WebRTC session.
//    Otherwise the running pipeline will store new memories
//    from the rest of this conversation. See "In-flight session"
//    below.
pcClient.disconnect();
```

---

## Why this exists

The bot writes long-term memories to Mem0 via Pipecat's `Mem0MemoryService`,
keyed on `user_id = str(user.mid)` (the Bilibili UID from the validated
`loginSyncToken`). Each logged-in viewer has their own private namespace; the
service auto-extracts memories from chat (e.g. "the user mentioned they're
allergic to seafood") and surfaces them in future conversations.

Some viewers will eventually want to:

- See what's stored about them (transparency / debugging an awkward
  greeting).
- Wipe it (privacy reset, fresh start, "right to be forgotten").

These two endpoints are the surface for that.

---

## Endpoints

### `GET /api/memories`

List every memory Mem0 has stored under the caller's UID. Returns at most
~1000 memories (Mem0's server-side default page size); paginate by passing
`?page=2&page_size=100` query params if you ever expect more (the backend
forwards them through to the SDK).

**Request**

```http
GET /api/memories HTTP/1.1
Authorization: Bearer <loginSyncToken>
```

**Response (200)**

```json
{
  "user_id": "12345678",
  "uname": "明前奶绿粉丝",
  "count": 3,
  "memories": [
    {
      "id": "8c4d…",
      "memory": "用户对海鲜过敏",
      "created_at": "2026-04-12T08:30:11Z",
      "updated_at": "2026-04-12T08:30:11Z",
      "categories": ["health"]
    },
    { "id": "…", "memory": "…", "created_at": "…", "updated_at": "…", "categories": null }
  ]
}
```

`count` is exactly `memories.length` — convenient when you only want to render
a count without iterating. Empty list (`count: 0`) is a normal `200`, not
`404`; render a friendly "nothing remembered yet" state.

`uname` is the validated Bilibili display name at the time the request was
processed; useful as a header in the UI ("明前奶绿对 *明前奶绿粉丝* 的记忆").

### `POST /api/memories/forget`

Bulk-delete every memory under the caller's UID. Idempotent — a second call
right after a successful first one returns the same shape (Mem0 returns OK
when the filtered set is empty).

**Request**

```http
POST /api/memories/forget HTTP/1.1
Authorization: Bearer <loginSyncToken>
```

(no body required.)

**Response (200)**

```json
{ "ok": true, "user_id": "12345678" }
```

---

## Errors

Both endpoints share the same error envelope. `error` is a Chinese
user-facing string for the auth/permission cases (so the FE can render it
verbatim) and an English diagnostic for upstream failures (which the FE
should map to its own copy).

| Status | When                                            | Body                                              |
| ------ | ----------------------------------------------- | ------------------------------------------------- |
| 401    | Missing / malformed / non-Bearer `Authorization`| `{ "error": "需要登录后才能查看记忆" }` (list)    |
| 401    | Token didn't validate as a logged-in viewer     | `{ "error": "需要登录后才能管理记忆" }` (forget)  |
| 502    | Mem0 API call failed (network, 5xx upstream)    | `{ "error": "Failed to load memories" }` etc.     |
| 503    | `MEM0_API_KEY` not configured on the bot        | `{ "error": "Mem0 service unavailable" }`         |

The `401` body differs by endpoint (list says "查看记忆", forget says
"管理记忆") — keeps the message scoped to the action the user was
attempting. Treat `401`s the same way you'd treat any other auth failure
(redirect to login / show the login-sync UI).

---

## Auth: header, not body

We use `Authorization: Bearer <token>` instead of putting the token in the
body (the way `/api/offer` does). Reasons:

1. `GET` is body-less by HTTP convention; a header works for both verbs and
   keeps the API symmetric.
2. Most reverse proxies redact `Authorization` headers from default access
   logs. Query strings and bodies are not redacted by default.

The token is the same `loginSyncToken` you already obtain from the
`login-sync-token-input` flow and embed in `requestData.loginSyncToken`
inside `/api/offer`. No new token needs to be minted.

The backend validates the token on every call against the same Workers helper
and the same in-process TTL cache used by `/api/offer`. So a viewer who hits
`/api/memories/forget` immediately after connecting (or while connected) pays
zero extra Workers calls — the cache is already warm from the offer
validation.

---

## In-flight session caveat

If the viewer hits "Forget me" *while a WebRTC session is active*,
`Mem0MemoryService` is still running inside the live pipeline. It will keep
storing this session's transcript in the background — so memories created
*after* the deletion request survive.

Two reasonable UX patterns:

### Pattern A (recommended) — disconnect after wipe

If the user is currently connected, hang up the WebRTC session right after
the delete succeeds:

```ts
await fetch("/api/memories/forget", {
  method: "POST",
  headers: { Authorization: `Bearer ${loginSyncToken}` },
});
if (pcClient.connected) {
  await pcClient.disconnect();
}
showToast("记忆已清除");
```

This guarantees a clean wipe — no further memories accrue from the current
session.

### Pattern B — wipe-only, leave session running

Skip the disconnect. The current conversation keeps going. Anything the user
talks about *after* the wipe will be re-extracted into Mem0 once the bot
processes those turns. The user gets exactly what they asked for ("delete
everything from before this moment") but the namespace will refill organically
from this session's later content.

Pattern A is the safer default. Use Pattern B only if the UX really needs the
in-call wipe to be invisible (we don't think it does).

---

## UX checklist

- [ ] **Confirmation dialog before wipe.** This action is irreversible; Mem0
      doesn't expose an "undo" or trash. A simple "你确定要删除明前奶绿对你的全部记忆吗？此操作无法撤销" with a destructive-styled confirm button is enough.
- [ ] **Show count, not just a button.** "明前奶绿记得你的 3 条信息 [清除全部]" is much friendlier than a bare "Forget me" button — and the
      `GET /api/memories` count is free.
- [ ] **Optionally show the actual memories.** Each entry's `memory` field is
      a Chinese sentence the bot generated; rendering them in a list lets the
      user audit what's there. Sort by `created_at` descending.
- [ ] **Disable the button while the request is in flight.** The wipe is fast
      (typically <500 ms) but a network hiccup could stretch it; double-clicks
      shouldn't fire two requests.
- [ ] **Handle 401 by re-authenticating.** If the token expired between page
      load and click, send the user back through the login-sync flow rather
      than silently failing.
- [ ] **Surface success / failure toasts.** "记忆已清除" / "清除失败，请稍后再试".

---

## Related

- [`../laplace_eidolon/memory_admin.py`](../laplace_eidolon/memory_admin.py) —
  endpoint implementation + extensive inline rationale
- [`../laplace_eidolon/user_context.py`](../laplace_eidolon/user_context.py) —
  shared token-validation cache
- [`./frontend-loading-state.md`](./frontend-loading-state.md) — companion
  handover for surfacing pipeline state in the same client
- [Mem0 delete-memory docs](https://docs.mem0.ai/core-concepts/memory-operations/delete)
- Project README: [`../README.md`](../README.md)
