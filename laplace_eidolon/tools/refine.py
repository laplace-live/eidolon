"""LLM post-process raw stream transcripts into clean memory records.

Raw Whisper output of a watching/chatting stream interleaves the streamer's
own commentary, audio from the media she's watching, and viewer SC reads into
one undifferentiated transcript, so retrieval over it returns anime dialogue
and "谢谢XXX的SC..." rather than anything the persona said. Every H2 chunk is
rewritten through an LLM into a structured record; ``tools/ingest_streams.py``
then embeds the *summary* instead of the raw text.

The source ``streams/<id>.md`` is never overwritten — output goes to a
``streams/<id>.refined.json`` sidecar, and re-runs skip chunks already in it
unless ``--force`` is passed.

Override the default model with ``REFINE_MODEL`` or ``--model``.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, cast

from dotenv import load_dotenv
from loguru import logger
from openai import APIError, AsyncOpenAI
from pydantic import BaseModel, Field

from ..env import env_int
from ..openrouter import extract_cost_usd, openrouter_headers
from ._streams import (
    ParsedStream,
    StreamChunk,
    iter_streams,
    load_sidecar,
    parse_stream,
    save_sidecar,
)

DEFAULT_MODEL = "~google/gemini-pro-latest"
DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_CONCURRENCY = 8
# Synthesize emits the long ``details`` field; extract only short arrays.
DEFAULT_EXTRACT_MAX_TOKENS = 4096
DEFAULT_SYNTHESIZE_MAX_TOKENS = 8192
# Extract must be faithful; synthesize is narrative prose.
DEFAULT_EXTRACT_TEMPERATURE = 0.2
DEFAULT_SYNTHESIZE_TEMPERATURE = 0.4
SCHEMA_VERSION = 2

# The Literal drives the Pydantic schema the LLM is decoded into; the set is
# the runtime fallback in ``_validate_synthesis``.
ChunkType = Literal[
    "opening",
    "commentary",
    "sc_session",
    "anime_audio",
    "karaoke",
    "mixed",
    "transition",
    "closing",
]
VALID_CHUNK_TYPES = set(ChunkType.__args__)


# These models constrain the LLM at decode time via
# ``response_format=json_schema``, but providers occasionally ignore that, so
# ``_validate_extract`` / ``_validate_synthesis`` still run on the parsed
# payload and ``_parse_json_lenient`` is the last resort.


class _StrictModel(BaseModel):
    """Base model that emits a strict, OpenAI-compatible JSON Schema."""

    model_config = {"extra": "forbid"}


class SCEventSchema(_StrictModel):
    viewer: str = Field(default="", description="Viewer name as transcribed; empty if unknown.")
    amount_yuan: int | None = Field(default=None, description="SC amount in yuan, if mentioned.")
    content: str = Field(default="", description="What the SC said, verbatim Chinese.")
    response: str = Field(default="", description="\u5976\u7eff's reply to this SC.")


class SongSchema(_StrictModel):
    title: str = Field(default="", description="Song title.")
    note: str = Field(default="", description="Context: sang it / \u5207\u6b4c / just chatted.")


class ExtractSchema(_StrictModel):
    sc_events: list[SCEventSchema] = Field(default_factory=list)
    songs: list[SongSchema] = Field(default_factory=list)
    events: list[str] = Field(default_factory=list)
    promises: list[str] = Field(default_factory=list)
    topics: list[str] = Field(default_factory=list)
    mentions: list[str] = Field(default_factory=list)
    key_quotes: list[str] = Field(default_factory=list)
    is_anime_audio_dominant: bool = False
    is_karaoke_dominant: bool = False


class SynthesisSchema(_StrictModel):
    heading: str = Field(description="6-30 Chinese characters, semantic label.")
    summary: str = Field(description="1-2 Chinese sentences capturing the chunk's essence.")
    details: str = Field(default="", description="12-20 Chinese sentences, first-person POV.")
    chunk_type: ChunkType = Field(default="commentary")


def _strict_json_schema(model_cls: type[BaseModel], name: str) -> dict[str, Any]:
    """Convert a Pydantic model to an OpenRouter ``json_schema`` block.

    OpenRouter passes ``schema`` straight through, and Gemini's strict mode
    rejects any schema missing ``additionalProperties: false`` or with an
    incomplete ``required`` list — so patch both at every nesting level.
    """
    schema = model_cls.model_json_schema()

    def _harden(node: Any) -> None:
        if not isinstance(node, dict):
            return
        if node.get("type") == "object":
            node["additionalProperties"] = False
            props = node.get("properties") or {}
            if props:
                # Strict mode wants every property required.
                node["required"] = list(props.keys())
        for value in node.values():
            if isinstance(value, dict):
                _harden(value)
            elif isinstance(value, list):
                for item in value:
                    _harden(item)

    # Nested models land in ``$defs`` at the top level; harden those too.
    for defn in (schema.get("$defs") or {}).values():
        _harden(defn)
    _harden(schema)

    return {
        "type": "json_schema",
        "json_schema": {
            "name": name,
            "strict": True,
            "schema": schema,
        },
    }


EXTRACT_RESPONSE_FORMAT = _strict_json_schema(ExtractSchema, "ExtractResult")
SYNTHESIS_RESPONSE_FORMAT = _strict_json_schema(SynthesisSchema, "SynthesisResult")

# Fallback for when OpenRouter doesn't return cost, as model -> (USD per 1M
# input tokens, USD per 1M output tokens). OpenRouter is the source of truth.
PRICING_USD_PER_1M: dict[str, tuple[float, float]] = {
    "google/gemini-2.0-flash-001": (0.10, 0.40),
    "google/gemini-flash-1.5": (0.075, 0.30),
    "google/gemini-flash-1.5-8b": (0.0375, 0.15),
    "google/gemini-flash-latest": (0.075, 0.30),
    # OpenRouter `~` prefix = "always latest" alias; same pricing.
    "~google/gemini-flash-latest": (0.075, 0.30),
    "google/gemini-2.5-flash-lite": (0.10, 0.40),
    "anthropic/claude-haiku-latest": (0.80, 4.00),
    "anthropic/claude-3-5-haiku-20241022": (0.80, 4.00),
    "anthropic/claude-3-5-haiku-latest": (0.80, 4.00),
    "openai/gpt-4o-mini": (0.15, 0.60),
    "openai/gpt-4o-mini-2024-07-18": (0.15, 0.60),
    "openai/gpt-5-nano": (0.05, 0.40),
    "deepseek/deepseek-chat-v3.1": (0.27, 1.10),
}

EXTRACT_SYSTEM_PROMPT = """\
You are a faithful extractor for a Chinese livestream archive.

The streamer is **明前奶绿** (奶绿), a Chinese-language Vtuber (VUP). Each
chunk's transcript interleaves several streams that are NOT distinguished
by speaker labels:

- Her own narration / chat / reactions ← capture these.
- Audio from media she watches (anime, movies, games — Japanese, English).
  These are NOT her words. Drop them.
- Songs she sings (full lyrics appear). Capture the song title only —
  and NEVER name a song unless the title is explicitly spoken in the
  transcript. Do not identify songs from lyric fragments: transcribed
  lyrics are unreliable (often misheard across languages) and a confident
  wrong title poisons the archive. If she sings but no title is spoken,
  use {"title": "", "note": "<quote the lyric fragment verbatim>"}.
- Reading viewer SuperChats (SCs) in patterns like "感谢XXX的SC...", "谢谢XXX的SC..." —
  capture EVERY SC verbatim along with her response.

Be FAITHFUL. Do not invent, paraphrase loosely, or compress aggressively.
If a field doesn't apply, return an empty array. Output JSON ONLY:

{
  "sc_events": [
    {
      "viewer": "<viewer name as transcribed>",
      "amount_yuan": <integer in yuan if mentioned, else null>,
      "content": "<what the SC text said, verbatim Chinese, lightly cleaned>",
      "response": "<奶绿's reply: verbatim if memorable and short, otherwise a tight Chinese paraphrase>"
    }
  ],
  "songs": [
    {"title": "<song title>", "note": "<context: did she sing it / 切歌 / chat about it>"}
  ],
  "events": [
    "<notable things 奶绿 actually did or said in this window — e.g. '突击开播', '为IKN尼玛尼玛呀唱了生日快乐歌', '差点哭出来'>"
  ],
  "promises": [
    "<things she explicitly committed to — '下次见就是下个月了', '会再见', '答应大家XXX'>"
  ],
  "topics": ["<3-7 short Chinese topic tags covering this chunk>"],
  "mentions": [
    "<viewer / song / brand / real-person names she actually addressed; EXCLUDE characters from the media she was watching>"
  ],
  "key_quotes": [
    "<1-5 of the most quotable verbatim Chinese lines she said in this chunk; pick lines that are pithy, in-character, or memorable>"
  ],
  "is_anime_audio_dominant": <true if >70% of the chunk is transcribed show dialogue with minimal commentary>,
  "is_karaoke_dominant": <true if >70% of the chunk is song lyrics being sung>
}

Output JSON only, no markdown, no preamble."""

EXTRACT_USER_TEMPLATE = """\
Stream context:
{context}

Chunk timestamp: {timestamp}

Transcript:
{text}"""

SYNTHESIZE_SYSTEM_PROMPT = """\
You are an archivist creating a memory record for a Chinese-language Vtuber's
long-term recall system.

Input is a structured extract from one ~5 minute chunk of 明前奶绿's
livestream. Use ONLY information from the extract and the existing heading
hint — do NOT invent details.

Output JSON ONLY:

{
  "heading": "<6-30 Chinese characters, semantic label. Replace the existing heading if it's just first-spoken-words or filler ('哈哈', '嗯', '等一下', '変身', 'は').>",
  "summary": "<EXACTLY 1-2 Chinese sentences capturing the chunk's essence in 奶绿's first-person POV. THIS IS WHAT GETS EMBEDDED for retrieval, so keep it focused on the chunk's main subject — don't pile in every detail.>",
  "details": "<12-20 Chinese sentences in 奶绿's first-person POV. Rich narrative covering: what she did, songs sung, viewer SC interactions (cite specific viewer names from the extract), promises, jokes, opinions. Weave in 1-3 verbatim quotes from key_quotes naturally. THIS gets shown to the persona at recall time so she can answer specifically — make it useful, specific, and grounded only in the extract.>",
  "chunk_type": "<one of: opening | commentary | sc_session | anime_audio | karaoke | mixed | transition | closing>"
}

chunk_type guidelines:
- opening: stream opening, greeting viewers
- commentary: her own thoughts, opinions, jokes, plans (the gold)
- sc_session: 3+ SC events in the extract → use this
- anime_audio: extract.is_anime_audio_dominant is true
- karaoke: extract.is_karaoke_dominant is true
- mixed: significant overlap of two of the above
- transition: brief setup between sections (extract is mostly empty)
- closing: stream ending, farewells

If sc_session: in details, name AT LEAST 3 of the most notable viewers and what their SCs were about.
If anime_audio or karaoke: keep summary brief (just note the scene/song); details can be 3-5 sentences instead of 8-15.
Never name a song unless its title appears explicitly in the extract — if a
songs entry has an empty title, describe the singing without naming a song.

Output JSON only, no markdown, no preamble."""

SYNTHESIZE_USER_TEMPLATE = """\
Stream context:
{context}

Chunk timestamp: {timestamp}
Existing heading (replace if it's a placeholder): {existing_heading}

Structured extract:
{extract_json}"""


def _get_client() -> AsyncOpenAI:
    """OpenAI-SDK client pointed at OpenRouter (or whatever REFINE_BASE_URL)."""
    base_url = os.getenv("REFINE_BASE_URL", DEFAULT_BASE_URL)
    api_key = os.getenv("REFINE_API_KEY") or os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError(
            "Refinement needs an API key. Set OPENROUTER_API_KEY (reused from "
            "the LLM config) or REFINE_API_KEY for a different provider."
        )
    return AsyncOpenAI(
        base_url=base_url,
        api_key=api_key,
        # Refinement is offline batch work; let it retry on flakes.
        max_retries=4,
        default_headers=openrouter_headers(),
    )


@dataclass
class Usage:
    """Token + cost accumulator for a refinement run."""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_usd: float = 0.0
    cost_source: str = "unknown"  # "openrouter" | "estimate" | "mixed" | "unknown"

    def add(self, other: "Usage") -> None:
        self.prompt_tokens += other.prompt_tokens
        self.completion_tokens += other.completion_tokens
        self.cost_usd += other.cost_usd
        # One estimated call marks the whole run, so the printed total is never
        # mistaken for audit-quality.
        if other.cost_source == "estimate" and self.cost_source == "openrouter":
            self.cost_source = "mixed"
        elif self.cost_source == "unknown":
            self.cost_source = other.cost_source


def _extract_usage(resp_dict: dict[str, Any], model: str) -> Usage:
    """Pull token + cost data out of an OpenAI/OpenRouter response.

    OpenRouter returns ``usage.cost`` in USD when the request sets
    ``usage.include``; ``extract_cost_usd`` owns the BYOK fallback.
    Providers that return neither fall back to the price table.
    """
    usage_raw = (resp_dict.get("usage") or {}) if isinstance(resp_dict, dict) else {}
    prompt = int(usage_raw.get("prompt_tokens", 0) or 0)
    completion = int(usage_raw.get("completion_tokens", 0) or 0)

    cost = extract_cost_usd(usage_raw)
    if cost is not None:
        return Usage(
            prompt_tokens=prompt,
            completion_tokens=completion,
            cost_usd=cost,
            cost_source="openrouter",
        )

    pricing = PRICING_USD_PER_1M.get(model)
    if pricing is not None:
        in_price, out_price = pricing
        cost_est = (prompt * in_price + completion * out_price) / 1_000_000
        return Usage(
            prompt_tokens=prompt,
            completion_tokens=completion,
            cost_usd=cost_est,
            cost_source="estimate",
        )

    logger.warning(
        f"No cost data and no pricing entry for {model!r}; reporting "
        "tokens only. Add it to PRICING_USD_PER_1M to fix."
    )
    return Usage(
        prompt_tokens=prompt,
        completion_tokens=completion,
        cost_usd=0.0,
        cost_source="unknown",
    )


def _stream_context(parsed: ParsedStream) -> str:
    """Context line prefixed to every chunk prompt for one stream.

    Built deterministically from frontmatter so the prompt is byte-stable
    across runs — better prompt caching, reproducible cost.
    """
    meta = parsed.metadata
    parts = []
    if meta.get("stream_date"):
        parts.append(f"date={meta['stream_date']}")
    if meta.get("language"):
        parts.append(f"language={meta['language']}")
    if meta.get("mood"):
        parts.append(f"mood={meta['mood']}")
    if meta.get("notes"):
        parts.append(f"notes={meta['notes']}")
    if meta.get("duration_min"):
        parts.append(f"duration_min={meta['duration_min']}")
    return "; ".join(parts) if parts else "(no frontmatter context)"


def _heading_timestamp(heading: str) -> str:
    """Pull the leading "00:15" / "01:23" out of a heading for the prompt."""
    parts = heading.split("—", 1)
    return parts[0].strip() if parts else heading[:8]


def _unwrap_list_payload(payload: Any) -> Any:
    """Unwrap the ``[...]`` array Gemini sometimes wraps a lone object in.

    Multi-element lists pass through untouched — the extract validator merges
    them, the synthesis validator takes the first.
    """
    if isinstance(payload, list):
        if not payload:
            raise ValueError("Empty list returned")
        if not all(isinstance(item, dict) for item in payload):
            raise ValueError("List contained non-dict items")
        if len(payload) == 1:
            return payload[0]
    return payload


def _validate_extract(payload: Any) -> dict[str, Any]:
    """Coerce a Pass-1 extract response into the structured-fields shape.

    Every key is always present, empty rather than missing, so callers need no
    per-field None checks.
    """
    payload = _unwrap_list_payload(payload)
    if isinstance(payload, list):
        # A multi-element list means the model split the chunk into
        # sub-extracts; union their arrays back together.
        merged: dict[str, list] = {
            k: []
            for k in (
                "sc_events",
                "songs",
                "events",
                "promises",
                "topics",
                "mentions",
                "key_quotes",
            )
        }
        is_anime = is_karaoke = False
        for item in payload:
            if not isinstance(item, dict):
                continue
            for k in merged:
                v = item.get(k) or []
                if isinstance(v, list):
                    merged[k].extend(v)
            is_anime = is_anime or bool(item.get("is_anime_audio_dominant"))
            is_karaoke = is_karaoke or bool(item.get("is_karaoke_dominant"))
        payload = {**merged, "is_anime_audio_dominant": is_anime, "is_karaoke_dominant": is_karaoke}

    if not isinstance(payload, dict):
        raise ValueError(f"Expected JSON object, got {type(payload).__name__}")

    def _str_list(key: str, cap: int = 50) -> list[str]:
        items = payload.get(key) or []
        if not isinstance(items, list):
            return []
        return [str(x).strip() for x in items if str(x).strip()][:cap]

    sc_events_raw = payload.get("sc_events") or []
    sc_events: list[dict[str, Any]] = []
    if isinstance(sc_events_raw, list):
        for sc in sc_events_raw:
            if not isinstance(sc, dict):
                continue
            viewer = str(sc.get("viewer", "")).strip()
            content = str(sc.get("content", "")).strip()
            if not viewer and not content:
                continue
            amount = sc.get("amount_yuan")
            try:
                amount_yuan = int(amount) if amount is not None else None
            except (TypeError, ValueError):
                amount_yuan = None
            sc_events.append(
                {
                    "viewer": viewer or "(unknown)",
                    "amount_yuan": amount_yuan,
                    "content": content,
                    "response": str(sc.get("response", "")).strip(),
                }
            )

    songs_raw = payload.get("songs") or []
    songs: list[dict[str, Any]] = []
    if isinstance(songs_raw, list):
        for s in songs_raw:
            if isinstance(s, dict):
                title = str(s.get("title", "")).strip()
                if title:
                    songs.append(
                        {
                            "title": title,
                            "note": str(s.get("note", "")).strip(),
                        }
                    )
            elif isinstance(s, str) and s.strip():
                # Tolerate the model emitting plain string titles.
                songs.append({"title": s.strip(), "note": ""})

    return {
        "sc_events": sc_events,
        "songs": songs,
        "events": _str_list("events"),
        "promises": _str_list("promises"),
        "topics": _str_list("topics", cap=10),
        "mentions": _str_list("mentions"),
        "key_quotes": _str_list("key_quotes", cap=10),
        "is_anime_audio_dominant": bool(payload.get("is_anime_audio_dominant")),
        "is_karaoke_dominant": bool(payload.get("is_karaoke_dominant")),
    }


def _validate_synthesis(payload: Any) -> dict[str, Any]:
    """Coerce a Pass-2 synthesis response into heading/summary/details/type."""
    payload = _unwrap_list_payload(payload)
    if isinstance(payload, list):
        # A split synthesis still carries the right heading + summary in its
        # first item.
        payload = payload[0]
    if not isinstance(payload, dict):
        raise ValueError(f"Expected JSON object, got {type(payload).__name__}")

    heading = str(payload.get("heading", "")).strip()
    summary = str(payload.get("summary", "")).strip()
    details = str(payload.get("details", "")).strip()
    if not heading or not summary:
        raise ValueError("heading and summary are required from synthesis")

    chunk_type = str(payload.get("chunk_type", "commentary")).strip().lower()
    if chunk_type not in VALID_CHUNK_TYPES:
        chunk_type = "commentary"

    return {
        "heading": heading,
        "summary": summary,
        "details": details,
        "chunk_type": chunk_type,
    }


def _sanitize_json_text(text: str) -> str:
    """Escape raw control chars inside JSON string literals.

    Gemini's JSON mode emits literal newlines inside string values, which
    strict ``json.loads`` rejects. Only in-string chars are rewritten: a
    whole-body regex would also hit the harmless newlines that pretty-printed
    JSON puts between structural tokens.
    """
    out: list[str] = []
    in_string = False
    escape = False
    for ch in text:
        if in_string:
            if escape:
                out.append(ch)
                escape = False
                continue
            if ch == "\\":
                out.append(ch)
                escape = True
                continue
            if ch == '"':
                out.append(ch)
                in_string = False
                continue
            cp = ord(ch)
            if cp < 0x20:
                if ch == "\n":
                    out.append("\\n")
                elif ch == "\r":
                    out.append("\\r")
                elif ch == "\t":
                    out.append("\\t")
                else:
                    out.append(f"\\u{cp:04x}")
                continue
            out.append(ch)
        else:
            out.append(ch)
            if ch == '"':
                in_string = True
    return "".join(out)


def _parse_first_json_value(text: str) -> Any:
    """Parse the first complete JSON value in ``text``, ignoring trailing junk.

    Gemini sometimes appends a stray ``}`` or a repeat of the object after an
    otherwise fine payload. Raises ``json.JSONDecodeError`` if no valid value
    starts at the head of the stripped text.
    """
    decoder = json.JSONDecoder()
    obj, _end = decoder.raw_decode(text.lstrip())
    return obj


def _parse_json_lenient(content: str) -> tuple[Any, str | None]:
    """Try a strict parse, then each repair pass in turn.

    Returns ``(parsed, repair_note)``, where ``repair_note`` is ``None`` for a
    clean strict parse and otherwise names the repair that worked. Returns
    ``(None, error_str)`` if every pass failed — the error comes from the
    strict pass, which is the one that points at the actual fault.
    """
    try:
        return json.loads(content), None
    except json.JSONDecodeError as strict_err:
        sanitized = _sanitize_json_text(content)
        try:
            return json.loads(sanitized), "sanitized"
        except json.JSONDecodeError:
            pass
        try:
            return _parse_first_json_value(content), "truncated_trailing"
        except json.JSONDecodeError:
            pass
        try:
            return _parse_first_json_value(sanitized), "sanitized+truncated"
        except json.JSONDecodeError:
            pass
        return None, str(strict_err)


async def _call_llm_json(
    client: AsyncOpenAI,
    model: str,
    *,
    system: str,
    user: str,
    temperature: float,
    max_tokens: int,
    response_format: dict[str, Any] | None = None,
) -> tuple[Any, Usage]:
    """One LLM call returning (parsed JSON, usage).

    Returns ``(None, Usage())`` when the call itself fails, or
    ``(None, usage)`` when the body wouldn't parse — cost is still accounted
    for on parse failures. A ``finish_reason`` of ``"length"`` buys one retry
    at double the token budget.

    ``response_format`` defaults to loose ``{"type": "json_object"}``; pass a
    block from ``_strict_json_schema`` for schema-validated decoding.
    """
    if response_format is None:
        response_format = {"type": "json_object"}
    use_strict = response_format.get("type") == "json_schema"
    extra_body: dict[str, Any] = {"usage": {"include": True}}
    if use_strict:
        extra_body["provider"] = {"require_parameters": True}

    attempt_max_tokens = max_tokens
    last_usage = Usage()

    for attempt in range(2):  # 1 normal + 1 retry on truncation
        try:
            resp = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                # The SDK types this as a closed Union of TypedDicts, but the
                # wire format is plain JSON and OpenRouter accepts the
                # ``json_schema`` shape built above. Runtime is identical.
                response_format=cast(Any, response_format),
                temperature=temperature,
                max_tokens=attempt_max_tokens,
                # ``usage.include`` makes OpenRouter return cost in USD;
                # ``provider.require_parameters`` makes it skip providers that
                # would silently drop the schema and hand back free-form JSON.
                # Neither field is modelled by the OpenAI SDK.
                extra_body=extra_body,
            )
        except APIError as e:
            logger.error(f"  API error: {e}")
            return None, last_usage

        resp_dict = resp.model_dump() if hasattr(resp, "model_dump") else {}
        usage = _extract_usage(resp_dict, model)
        last_usage.add(usage)

        choice = resp.choices[0] if resp.choices else None
        content = choice.message.content if choice else ""
        finish_reason = getattr(choice, "finish_reason", None) if choice else None

        if not content:
            logger.error(
                f"  empty response (finish_reason={finish_reason!r}, "
                f"max_tokens={attempt_max_tokens})"
            )
            # Empty + length means the prompt itself blew the budget, so a
            # bigger max_tokens retry won't help.
            return None, last_usage

        parsed, repair_note = _parse_json_lenient(content)
        if parsed is not None:
            if repair_note:
                logger.warning(
                    f"  recovered malformed JSON via {repair_note} "
                    f"(finish_reason={finish_reason!r}, body_len={len(content)})"
                )
            return parsed, last_usage

        if finish_reason == "length" and attempt == 0:
            new_budget = min(attempt_max_tokens * 2, 16384)
            logger.warning(
                f"  truncated response (finish_reason=length, body_len={len(content)}); "
                f"retrying with max_tokens={new_budget}"
            )
            attempt_max_tokens = new_budget
            continue

        # Out of retries — log enough of the body to diagnose offline.
        head = content[:600]
        tail = content[-400:] if len(content) > 1000 else ""
        logger.error(
            f"  invalid JSON ({repair_note}); "
            f"finish_reason={finish_reason!r}, body_len={len(content)}, "
            f"head={head!r}" + (f", tail={tail!r}" if tail else "")
        )
        return None, last_usage

    return None, last_usage


async def _refine_one(
    client: AsyncOpenAI,
    model: str,
    parsed: ParsedStream,
    chunk: StreamChunk,
    sem: asyncio.Semaphore,
) -> tuple[StreamChunk, dict[str, Any] | None, Usage]:
    """Two-pass refine: extract structured data, then synthesize prose.

    A ``None`` refinement means one of the passes failed; the chunk stays
    unrefined and re-running the command retries it. Usage from both passes is
    returned either way, so a failed run still reports what it cost.
    """
    context = _stream_context(parsed)
    timestamp = _heading_timestamp(chunk.heading)
    total_usage = Usage()

    async with sem:
        extract_user = EXTRACT_USER_TEMPLATE.format(
            context=context,
            timestamp=timestamp,
            text=chunk.text,
        )
        extract_raw, usage1 = await _call_llm_json(
            client,
            model,
            system=EXTRACT_SYSTEM_PROMPT,
            user=extract_user,
            temperature=DEFAULT_EXTRACT_TEMPERATURE,
            max_tokens=DEFAULT_EXTRACT_MAX_TOKENS,
            response_format=EXTRACT_RESPONSE_FORMAT,
        )
        total_usage.add(usage1)
        if extract_raw is None:
            logger.error(f"  ✗ {chunk.id}: pass 1 (extract) failed")
            return chunk, None, total_usage

        try:
            extract = _validate_extract(extract_raw)
        except (json.JSONDecodeError, ValueError) as e:
            logger.error(f"  ✗ {chunk.id}: extract validation failed: {e}")
            return chunk, None, total_usage

        synth_user = SYNTHESIZE_USER_TEMPLATE.format(
            context=context,
            timestamp=timestamp,
            existing_heading=chunk.heading,
            extract_json=json.dumps(extract, ensure_ascii=False),
        )
        synth_raw, usage2 = await _call_llm_json(
            client,
            model,
            system=SYNTHESIZE_SYSTEM_PROMPT,
            user=synth_user,
            temperature=DEFAULT_SYNTHESIZE_TEMPERATURE,
            max_tokens=DEFAULT_SYNTHESIZE_MAX_TOKENS,
            response_format=SYNTHESIS_RESPONSE_FORMAT,
        )
        total_usage.add(usage2)
        if synth_raw is None:
            logger.error(f"  ✗ {chunk.id}: pass 2 (synthesize) failed")
            return chunk, None, total_usage

        try:
            synthesis = _validate_synthesis(synth_raw)
        except (json.JSONDecodeError, ValueError) as e:
            logger.error(f"  ✗ {chunk.id}: synthesis validation failed: {e}")
            return chunk, None, total_usage

    refinement = {
        "heading": synthesis["heading"],
        "summary": synthesis["summary"],
        "details": synthesis["details"],
        "chunk_type": synthesis["chunk_type"],
        "topics": extract["topics"][:7],
        "mentions": extract["mentions"][:25],
        "key_quotes": extract["key_quotes"][:5],
        "sc_events": extract["sc_events"],
        "songs": extract["songs"],
        "events": extract["events"][:15],
        "promises": extract["promises"][:10],
    }
    return chunk, refinement, total_usage


def _is_v2_refinement(rec: Any) -> bool:
    return isinstance(rec, dict) and "details" in rec and "key_quotes" in rec


@dataclass
class StreamResult:
    """What happened to one stream during a refine run."""

    parsed: ParsedStream
    chunks_total: int
    chunks_skipped: int
    chunks_succeeded: int
    chunks_failed: int
    usage: Usage
    duration_sec: float
    error: str | None = None


async def refine_stream(
    client: AsyncOpenAI,
    model: str,
    parsed: ParsedStream,
    *,
    force: bool,
    concurrency: int,
    save_every: int = 16,
) -> StreamResult:
    """Refine every chunk in one stream, writing the sidecar incrementally."""
    started = time.monotonic()
    sidecar = load_sidecar(parsed)
    if force:
        sidecar["chunks"] = {}
    sidecar["schema_version"] = SCHEMA_VERSION

    v1_chunks = [cid for cid, rec in sidecar["chunks"].items() if not _is_v2_refinement(rec)]
    if v1_chunks and not force:
        logger.warning(
            f"  {parsed.md_path.name}: {len(v1_chunks)} chunks are still in v1 "
            f"format (no `details` / `sc_events`). Re-run with --force to upgrade."
        )

    todo = [c for c in parsed.chunks if c.id not in sidecar["chunks"]]
    skipped = len(parsed.chunks) - len(todo)

    if not todo:
        logger.info(f"  {parsed.md_path.name}: all {len(parsed.chunks)} chunks already refined")
        return StreamResult(
            parsed=parsed,
            chunks_total=len(parsed.chunks),
            chunks_skipped=skipped,
            chunks_succeeded=0,
            chunks_failed=0,
            usage=Usage(),
            duration_sec=0.0,
        )

    logger.info(
        f"  {parsed.md_path.name}: {len(todo)} chunks to refine "
        f"({skipped} already done) using {model}"
    )

    sem = asyncio.Semaphore(concurrency)
    tasks = [asyncio.create_task(_refine_one(client, model, parsed, chunk, sem)) for chunk in todo]

    total_usage = Usage()
    succeeded = 0
    failed = 0
    completed = 0

    for coro in asyncio.as_completed(tasks):
        chunk, refinement, usage = await coro
        total_usage.add(usage)
        completed += 1

        if refinement is None:
            failed += 1
        else:
            sidecar["chunks"][chunk.id] = refinement
            succeeded += 1
            logger.debug(
                f"  ✓ {chunk.id} ({completed}/{len(todo)}): "
                f"{refinement['heading']!r} [{refinement['chunk_type']}]"
            )

        # Periodic checkpoint so a Ctrl-C doesn't lose all progress.
        if completed % save_every == 0:
            sidecar["model"] = model
            sidecar["refined_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
            save_sidecar(parsed, sidecar)
            logger.info(
                f"  ... {completed}/{len(todo)} done, running cost: ${total_usage.cost_usd:.4f}"
            )

    sidecar["model"] = model
    sidecar["refined_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    sidecar["stats"] = {
        "chunks_total": len(parsed.chunks),
        "chunks_refined": len(sidecar["chunks"]),
        "tokens_in": total_usage.prompt_tokens,
        "tokens_out": total_usage.completion_tokens,
        "cost_usd": round(total_usage.cost_usd, 6),
        "cost_source": total_usage.cost_source,
        "model": model,
        "duration_sec": round(time.monotonic() - started, 2),
    }
    save_sidecar(parsed, sidecar)

    return StreamResult(
        parsed=parsed,
        chunks_total=len(parsed.chunks),
        chunks_skipped=skipped,
        chunks_succeeded=succeeded,
        chunks_failed=failed,
        usage=total_usage,
        duration_sec=time.monotonic() - started,
    )


def _fmt_cost(usage: Usage) -> str:
    if usage.cost_source == "unknown":
        return "(not priced)"
    note = "" if usage.cost_source == "openrouter" else f" ({usage.cost_source})"
    return f"${usage.cost_usd:.4f}{note}"


def print_run_summary(results: list[StreamResult], model: str, total_duration: float) -> None:
    """Per-file table + overall totals."""
    overall = Usage()
    chunks_total = chunks_succeeded = chunks_failed = chunks_skipped = 0

    print()
    print("=" * 72)
    print("Refinement Summary")
    print("=" * 72)
    print(f"{'File':<40} {'New':>5} {'Skip':>5} {'Fail':>5} {'Tokens':>14} {'Cost':>10}")
    print("-" * 72)

    for r in results:
        overall.add(r.usage)
        chunks_total += r.chunks_total
        chunks_succeeded += r.chunks_succeeded
        chunks_failed += r.chunks_failed
        chunks_skipped += r.chunks_skipped

        tokens = f"{r.usage.prompt_tokens:>6}/{r.usage.completion_tokens:>6}"
        cost = f"${r.usage.cost_usd:.4f}" if r.usage.cost_usd else "—"
        name = r.parsed.md_path.name
        if len(name) > 40:
            name = name[:37] + "..."
        print(
            f"{name:<40} {r.chunks_succeeded:>5} {r.chunks_skipped:>5} "
            f"{r.chunks_failed:>5} {tokens:>14} {cost:>10}"
        )

    print("-" * 72)
    tokens_total = f"{overall.prompt_tokens:>6}/{overall.completion_tokens:>6}"
    print(
        f"{'TOTAL':<40} {chunks_succeeded:>5} {chunks_skipped:>5} "
        f"{chunks_failed:>5} {tokens_total:>14} {_fmt_cost(overall):>10}"
    )
    print("=" * 72)
    print(f"Model:    {model}")
    print(f"Duration: {total_duration:.1f}s")
    if chunks_succeeded:
        avg_cost = overall.cost_usd / chunks_succeeded if overall.cost_usd else 0
        avg_time = total_duration / chunks_succeeded
        print(
            f"Per chunk: {avg_time:.2f}s avg, ${avg_cost:.6f} avg"
            if avg_cost
            else f"Per chunk: {avg_time:.2f}s avg"
        )
    if chunks_failed:
        print(
            f"\n⚠  {chunks_failed} chunks failed and stay unrefined — re-run "
            "the same command to retry just the failures."
        )
    if overall.cost_source == "unknown":
        print(
            "\n⚠  Cost is 0 because the model isn't in the local price table "
            "and OpenRouter didn't return cost. Tokens are accurate."
        )
    elif overall.cost_source != "openrouter":
        print(
            f"\nℹ  Cost source: {overall.cost_source}. OpenRouter didn't surface "
            "per-call cost for some/all calls; fell back to local price table."
        )
    print()


@dataclass
class CLIArgs:
    paths: list[Path] = field(default_factory=list)
    streams_dir: Path = Path("streams")
    model: str = DEFAULT_MODEL
    concurrency: int = DEFAULT_CONCURRENCY
    force: bool = False
    dry_run: bool = False


def _select_streams(args: CLIArgs) -> list[ParsedStream]:
    if args.paths:
        out: list[ParsedStream] = []
        for p in args.paths:
            if not p.exists():
                logger.error(f"File not found: {p}")
                continue
            out.append(parse_stream(p))
        return out
    return iter_streams(args.streams_dir.resolve())


def _dry_run_report(streams: list[ParsedStream], model: str) -> None:
    """Estimate refinement cost without spending any tokens.

    The char-to-token ratio of 2 is a cross-language upper bound — Chinese
    runs ~1.5 tokens/char, English ~0.25 — so real runs land at 70-90% of
    what this prints.
    """
    print()
    print(f"Dry run — model: {model}  (two-pass: extract → synthesize)")
    print("(estimates based on char count; actual cost is usually a bit lower)")
    print()
    pricing = PRICING_USD_PER_1M.get(model, (0.0, 0.0))

    total_chunks = total_in = total_out = 0
    for parsed in streams:
        sidecar = load_sidecar(parsed)
        # v1 chunks only get re-done under --force, which isn't visible from
        # here, so count them in and over-estimate rather than under.
        new = [
            c
            for c in parsed.chunks
            if c.id not in sidecar["chunks"] or not _is_v2_refinement(sidecar["chunks"][c.id])
        ]
        if not new:
            print(f"  {parsed.md_path.name}: 0 new chunks")
            continue
        chars = sum(len(c.text) + len(c.heading) for c in new)
        p1_in = 600 * len(new) + chars // 2
        p1_out = 600 * len(new)
        p2_in = (500 + 600) * len(new)
        p2_out = 800 * len(new)
        in_tokens = p1_in + p2_in
        out_tokens = p1_out + p2_out
        cost = (in_tokens * pricing[0] + out_tokens * pricing[1]) / 1_000_000
        print(
            f"  {parsed.md_path.name}: {len(new)} chunks × 2 passes, "
            f"~{in_tokens:,} in / ~{out_tokens:,} out → ~${cost:.4f}"
        )
        total_chunks += len(new)
        total_in += in_tokens
        total_out += out_tokens

    total_cost = (total_in * pricing[0] + total_out * pricing[1]) / 1_000_000
    print()
    print(
        f"Estimated total: {total_chunks} chunks (2 passes each), "
        f"~{total_in:,} in / ~{total_out:,} out → ~${total_cost:.4f}"
    )
    if pricing == (0.0, 0.0):
        print(f"(model {model!r} not in local price table; estimate is $0)")
    print()


async def main_async(args: CLIArgs) -> int:
    streams = _select_streams(args)
    if not streams:
        logger.warning("No streams to process. Add files under streams/ or pass paths.")
        return 0

    if args.dry_run:
        _dry_run_report(streams, args.model)
        return 0

    client = _get_client()
    started = time.monotonic()
    logger.info(
        f"Refining {len(streams)} stream(s) with {args.model} "
        f"(concurrency={args.concurrency}, force={args.force})"
    )

    results: list[StreamResult] = []
    for parsed in streams:
        try:
            result = await refine_stream(
                client,
                args.model,
                parsed,
                force=args.force,
                concurrency=args.concurrency,
            )
        except Exception as e:  # noqa: BLE001 — keep batch going on any per-file crash
            logger.error(f"  ✗ {parsed.md_path.name}: {e}")
            result = StreamResult(
                parsed=parsed,
                chunks_total=len(parsed.chunks),
                chunks_skipped=0,
                chunks_succeeded=0,
                chunks_failed=len(parsed.chunks),
                usage=Usage(),
                duration_sec=0.0,
                error=str(e),
            )
        results.append(result)

    duration = time.monotonic() - started
    print_run_summary(results, args.model, duration)
    return 0 if all(r.error is None and r.chunks_failed == 0 for r in results) else 1


def main() -> int:
    load_dotenv(override=True)
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument(
        "paths",
        nargs="*",
        type=Path,
        help="Specific streams/*.md files to refine. Default: all under streams/",
    )
    parser.add_argument(
        "--streams-dir",
        type=Path,
        default=Path("streams"),
        help="Directory of *.md transcripts (default: streams)",
    )
    parser.add_argument(
        "--model",
        default=os.getenv("REFINE_MODEL", DEFAULT_MODEL),
        help=(
            f"OpenRouter model slug (default: $REFINE_MODEL or {DEFAULT_MODEL}). "
            "Cheaper bulk option: ~google/gemini-flash-latest."
        ),
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=env_int("REFINE_CONCURRENCY", DEFAULT_CONCURRENCY),
        help=f"Max concurrent LLM calls (default: {DEFAULT_CONCURRENCY})",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-refine all chunks even if a sidecar already exists.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Estimate cost without making any LLM calls.",
    )
    ns = parser.parse_args()
    args = CLIArgs(
        paths=list(ns.paths or []),
        streams_dir=ns.streams_dir,
        model=ns.model,
        concurrency=ns.concurrency,
        force=ns.force,
        dry_run=ns.dry_run,
    )
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
