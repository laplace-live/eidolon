import { stat } from "node:fs/promises";
import {
  buildGreetingKickoff,
  buildSystemInstruction,
  INTERRUPTED_EMPTY_TURN_PROMPT,
  PersonaFacts,
  retrievalGateFromEnv,
  StreamArchive,
} from "@eidolon/context";
import { createMemoryProvider, isMemoryConfigured } from "@eidolon/memory";
import { resolveDbPath } from "@eidolon/retrieval";
import {
  createSelfieTool,
  createVoiceTool,
  loadVoiceStyles,
  selfiePromptHint,
  voicePromptHint,
} from "@eidolon/tools";
import { onnxBackend } from "../audio.ts";
import { createLlm, createStt, createTts } from "./services.ts";
import type { SessionDeps } from "./session.ts";

/** pathlib's `Path.exists()`. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export const productionSessionDeps: SessionDeps = {
  createStt,
  createTts,
  createLlm,
  loadVoiceStyles,
  createVoiceTool,
  voicePromptHint,
  createSelfieTool,
  selfiePromptHint,
  buildSystemInstruction,
  interruptedEmptyTurnPrompt: INTERRUPTED_EMPTY_TURN_PROMPT,
  buildGreetingKickoff,
  dbPath: resolveDbPath,
  dbPathExists: pathExists,
  openArchive: (dbPath) => StreamArchive.open({ dbPath }),
  openFacts: (dbPath) => PersonaFacts.open({ dbPath }),
  retrievalGateFromEnv,
  isMemoryConfigured,
  createMemoryProvider,
  audioBackend: onnxBackend,
};
