// What a SETTINGS row is called and explained, by its path, and the settings form's other codes:
// groups, option labels, flags and why a value is refused.
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { REPLY_MODE_LABELS } from "@/features/chats/labels";
import type { RoleId } from "@/lib/providers";

/** Each row's title. */
export const SETTING_TITLES: Readonly<Record<string, MessageDescriptor>> = {
  persona: msg`Active Persona`,
  "local.viewerName": msg`Your Name`,
  "access.workersBaseUrl": msg`LAPLACE Workers URL`,
  "access.validateTtlSec": msg`Login Cache Seconds`,
  "access.anonRateLimitPerHour": msg`Anonymous Calls per Window`,
  "access.anonRateLimitWindowSec": msg`Anonymous Window Seconds`,
  "access.realIpHeader": msg`Client IP Header`,
  "access.allowedOrigins": msg`Allowed Browser Origins`,
  "access.chatPersonas": msg`Public Chat Personas`,
  "access.chatAnonQuota": msg`Anonymous Chat Turns per Hour`,
  "access.chatUserQuota": msg`Logged-in Chat Turns per Hour`,
  "network.cloudflareTurn.keyId": msg`Cloudflare TURN Key ID`,
  "network.cloudflareTurn.ttlSec": msg`TURN Credential Lifetime`,
  "network.stunUrl": msg`STUN URL`,
  "network.turnUrl": msg`TURN URL`,
  "network.turnUsername": msg`TURN Username`,
  "audio.opusBitrateBps": msg`Default Opus Bitrate`,
  "audio.opusBitrate.best": msg`Opus Bitrate: Best`,
  "audio.opusBitrate.medium": msg`Opus Bitrate: Medium`,
  "audio.opusBitrate.low": msg`Opus Bitrate: Low`,
  "audio.opusBitrate.lowest": msg`Opus Bitrate: Lowest`,
  "mcp.anonRateLimitPerHour": msg`MCP Anonymous Calls per Window`,
  "mcp.authRateLimitPerHour": msg`MCP Logged-in Calls per Window`,
  "mcp.rateLimitWindowSec": msg`MCP Window Seconds`,
  "mcp.allowedHosts": msg`MCP Allowed Hosts`,
  "memory.qdrant.host": msg`Qdrant Host`,
  "memory.qdrant.port": msg`Qdrant Port`,
  "memory.qdrant.collection": msg`Qdrant Collection`,
  "memory.historyDb": msg`Mem0 History Database`,
  "providers.openrouter.apiBase": msg`OpenRouter API Base`,
  "providers.openrouter.appName": msg`OpenRouter App Name`,
  "providers.openrouter.appUrl": msg`OpenRouter App URL`,
  "providers.openai.baseUrl": msg`OpenAI API Base`,
  "embeddings.provider": msg`Embedding Provider`,
  "embeddings.model": msg`Embedding Model`,
  "embeddings.dim": msg`Embedding Dimension`,
  "embeddings.baseUrl": msg`Embedding API Base`,
  "rerank.baseUrl": msg`Reranker API Base`,
  "refine.baseUrl": msg`Refine API Base`,
  "sources.ytDlp": msg`yt-dlp Binary`,
  "sources.cookiesFromBrowser": msg`Browser to Read Cookies From`,
  "sources.cookiesFile": msg`Cookies File`,
  "usage.db": msg`Usage Ledger`,
  prompt: msg`System Prompt File`,
  "identity.timezone": msg`Time Zone`,
  "voice.provider": msg`Voice Provider`,
  "voice.model": msg`Voice Model`,
  "voice.voiceId": msg`Voice`,
  "hearing.provider": msg`Speech Recognition Provider`,
  "hearing.model": msg`Speech Recognition Model`,
  "hearing.language": msg`Spoken Language`,
  "mind.provider": msg`Chat Provider`,
  "mind.model": msg`Chat Model`,
  "realtime.provider": msg`Realtime Provider`,
  "realtime.model": msg`Realtime Model`,
  "realtime.voice": msg({ message: "Realtime Voice", context: "realtime model's voice" }),
  "memory.searchLimit": msg`Memories per Turn`,
  "memory.searchThreshold": msg`Memory Score Threshold`,
  "memory.agentId": msg`Mem0 Agent ID`,
  "memory.runId": msg`Mem0 Run ID`,
  "memory.provider": msg`Memory Extraction Provider`,
  "memory.model": msg`Memory Extraction Model`,
  "knowledge.index": msg`Knowledge Index`,
  "knowledge.factsCandidates": msg`Fact Candidates`,
  "knowledge.archiveCandidates": msg`Stream Candidates`,
  "knowledge.rerank.enabled": msg`Rerank Results`,
  "knowledge.rerank.provider": msg`Reranker Provider`,
  "knowledge.rerank.model": msg`Reranker Model`,
  "knowledge.gate.enabled": msg`Retrieval Gate`,
  "knowledge.gate.provider": msg`Retrieval Gate Provider`,
  "knowledge.gate.model": msg`Retrieval Gate Model`,
  "knowledge.facts.files": msg`Fact Files`,
  "knowledge.facts.subject": msg`Fact Subject Pattern`,
  "knowledge.archive.skipTypes": msg`Scene Types Left Out of the Index`,
  "transcription.provider": msg`Transcription Provider`,
  "transcription.model": msg`Transcription Model`,
  "transcription.language": msg`Transcription Language`,
  "refine.provider": msg`Refine Provider`,
  "refine.model": msg`Refine Model`,
  "refine.concurrency": msg`Refine Concurrency`,
  "selfie.provider": msg`Selfie Provider`,
  "selfie.model": msg`Selfie Model`,
  "selfie.aspectRatio": msg`Selfie Aspect Ratio`,
  "selfie.quality": msg`Selfie Quality`,
  "selfie.ttlSeconds": msg`Selfie Lifetime`,
  "selfie.timeoutSeconds": msg`Selfie Timeout`,
  "selfie.references": msg`Selfie References`,
  "chat.interests": msg`Interests`,
  "chat.talkativeness": msg`Talkativeness`,
  "chat.replyMode": msg`Reply Mode`,
};

/** The line under a row, for the rows that have one. */
export const SETTING_HELP: Readonly<Record<string, MessageDescriptor>> = {
  "local.viewerName": msg`What she calls you in calls. Leave it empty and she uses no name.`,
  "memory.qdrant.host": msg`Memory is on while this is set. Use 127.0.0.1 for the Docker container setup shows.`,
  "memory.qdrant.port": msg`Default 6333.`,
  "memory.qdrant.collection": msg`Default eidolon_memories. A new embedding dimension needs a new collection.`,
  "memory.historyDb": msg`Default mem0/history.db in the data home.`,
  "embeddings.model": msg`Changing it means building every persona's knowledge index again.`,
  "embeddings.dim": msg`Changing it means building every persona's index again and a new memory collection.`,
  "embeddings.baseUrl": msg`Sends embeddings to an endpoint of your own, such as a proxy, instead of the provider's API.`,
  "rerank.baseUrl": msg`Sends reranking to an endpoint of your own instead of the provider's API.`,
  "refine.baseUrl": msg`Sends transcript refinement to an endpoint of your own instead of the provider's API.`,
  "sources.ytDlp": msg`Eidolon installs and updates its own yt-dlp unless this is set.`,
  "sources.cookiesFromBrowser": msg`The browser whose cookies yt-dlp uses for videos behind a login. Reading them may ask for your Keychain password.`,
  "sources.cookiesFile": msg`A cookies.txt for yt-dlp, which writes the merged cookies back into it.`,
  "usage.db": msg`Where calls and jobs record what they spend. Default usage.db in the data home.`,
  prompt: msg`Relative to her folder. Default prompt.md.`,
  "voice.model": msg`Fish Audio's drama-3 performs every delivery cue in her prompt. With other models, Eidolon takes out the cues they can't read before they're spoken.`,
  "hearing.language": msg`The language you speak in calls, as a two-letter code. Default zh.`,
  "mind.model": msg`Pick one the provider lists, or type any model id it serves.`,
  "realtime.provider": msg`One model hears, thinks and speaks, in place of the three. Experimental.`,
  "memory.agentId": msg`Empty keeps each persona's memories of you apart, under her own id.`,
  "knowledge.rerank.enabled": msg`Reranking costs about $0.002 per search.`,
  "knowledge.gate.enabled": msg`Skips the knowledge search on turns that don't ask about her.`,
  "knowledge.facts.files": msg`Name patterns for the files in her facts folder, comma-separated. Default *.txt.`,
  "transcription.language": msg`The language of her videos as a two-letter code, or none. Default zh.`,
  "selfie.quality": msg`Higher costs more and takes longer while you wait in the call.`,
  "selfie.references": msg`One per line, relative to her folder.`,
  "chat.interests": msg`Topics she cares about, separated by commas or 、. The director reads them with her summary to tell when a group's line is one she'd join in on. Empty means her summary alone.`,
  "chat.talkativeness": msg`How readily she joins in when no one addressed her, from 0 to 1. At 0 she answers only when she's addressed, or when no one else will answer you. Default 0.5.`,
  "chat.replyMode": msg`Whether she answers in text or with a voice message. Auto lets the director choose voice when a line suits it, more often after a voice message of yours. A chat's own reply mode overrides hers, and without a key for her voice she answers in text.`,
};

/** A choice's label by row and value; a value without one shows as it is. */
export const SETTING_OPTION_LABELS: Readonly<
  Record<string, Readonly<Record<string, MessageDescriptor>>>
> = {
  "sources.cookiesFromBrowser": {
    none: msg`None`,
  },
  "voice.model": {
    s1: msg`s1 (Retires 2026-12-31)`,
    "s2.1-pro-free": msg`s2.1-pro-free (Free, under Fair Use)`,
  },
  "chat.replyMode": REPLY_MODE_LABELS,
};

/** The headings a card's rows are grouped under. */
export const GROUP_LABELS: Readonly<Record<string, MessageDescriptor>> = {
  you: msg`You`,
  voice: msg`Voice`,
  persona: msg`Persona`,
  models: msg`Models`,
  memory: msg`Memory`,
  knowledge: msg`Knowledge`,
  videos: msg`Videos and Transcripts`,
  selfie: msg`Selfies`,
  providers: msg`Providers`,
  sources: msg`Downloads`,
  usage: msg`Usage`,
  production: msg`Public Deployment`,
  other: msg`Other`,
};

/** What a flag's three states say. */
export const FLAG_LABELS = {
  default: msg`Default`,
  on: msg`On`,
  off: msg`Off`,
} satisfies Record<string, MessageDescriptor>;

/** An optional role's default, where it has none: what being off means. */
export const PROVIDER_OFF_LABELS: Readonly<Partial<Record<RoleId, MessageDescriptor>>> = {
  realtime: msg`Off: Three Models`,
};

/** Why controls.ts refused a value, by the code it gives; `{min}` and `{max}` are the row's limits. */
export const INVALID_MESSAGES: Readonly<Record<string, MessageDescriptor>> = {
  "settings.form.invalid.number": msg`Enter a number, such as 0.5.`,
  "settings.form.invalid.integer": msg`Enter a whole number.`,
  "settings.form.invalid.min": msg`The smallest allowed value is {min}.`,
  "settings.form.invalid.max": msg`The largest allowed value is {max}.`,
  "settings.form.invalid.comma": msg`A path can't contain a comma.`,
  "settings.form.invalid.relative": msg`Use a path relative to the persona's folder that stays inside it.`,
  "settings.form.invalid.timezone": msg`Use a time zone name such as Asia/Shanghai.`,
  "settings.form.invalid.language": msg`Use a two-letter language code such as zh, or none.`,
};
