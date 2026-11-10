// A call on eidolon's voice engine: @eidolon/voice's loop, bound to a chat when the offer names one.
// docs/voice-engine.md.
import type { AllowedOffer } from "@eidolon/access";
import { CHAT_FORMAT, type ChatHeader, summarize } from "@eidolon/chat";
import { activePersona, errorText, logger, withPersona } from "@eidolon/config";
import { realtimeIn, select } from "@eidolon/providers";
import {
  type CallDeps,
  type CallTransport,
  type CloseReason,
  memoryCallLog,
  runVoiceCall,
} from "@eidolon/voice";
import {
  type AnyCallBinding,
  type BoundCall,
  bindCall,
  bindGroupCall,
  isGroupCall,
  reportEnd,
} from "./binding.ts";
import { logSessionStart } from "./start.ts";

/**
 * Why `host` can't hold a group call of `personas`; or null.
 * Throws when settings can't be read.
 */
export function groupReason(host: string, personas: readonly string[]): string | null {
  const realtime = realtimeIn(personas);
  if (realtime !== null) {
    return `${realtime}'s calls run on a realtime model, which can't join a group call`;
  }
  return personas.includes(host) ? null : `${host} isn't in the call`;
}

/** Never aborts: the signalling server's close disconnects every peer, which ends their calls. */
const NO_SHUTDOWN = new AbortController().signal;

/**
 * A call, logged as it starts; bound to `binding`, it runs as her and reports to its hooks. Never
 * rejects: a call that can't start logs `Bot session failed: …`, which the local app's status
 * reads, and disconnects.
 */
export async function runNativeSafely(
  transport: CallTransport,
  admission: Pick<AllowedOffer, "user" | "token" | "requestData">,
  deps: CallDeps,
  binding?: AnyCallBinding,
): Promise<void> {
  let reason: CloseReason = "error";
  try {
    reason =
      binding === undefined
        ? await runNative(transport, admission, deps)
        : await withPersona(binding.persona, () => runNative(transport, admission, deps, binding));
  } catch (error) {
    logger.error(`Bot session failed: ${errorText(error)}`, error);
    await transport.disconnect().catch((e: unknown) => {
      logger.warning(`Closing the failed session's connection failed: ${errorText(e)}`);
    });
  }
  if (binding !== undefined) reportEnd(binding, reason);
}

/** The call, as the persona in scope; rejects when it can't be planned. */
async function runNative(
  transport: CallTransport,
  admission: Pick<AllowedOffer, "user" | "token" | "requestData">,
  deps: CallDeps,
  binding?: AnyCallBinding,
): Promise<CloseReason> {
  logSessionStart(admission);
  const id = Bun.randomUUIDv7();
  const host = binding?.persona ?? activePersona().id;
  let call: BoundCall;
  let group = false;
  if (isGroupCall(binding)) {
    // The chat's own header and events, under the call's id: every persona in it answers.
    const { chat } = binding;
    const reason = groupReason(host, summarize(chat.header, chat.events).participants);
    if (reason !== null) throw new Error(reason);
    const log = memoryCallLog({ ...chat.header, id }, chat.events);
    call = bindGroupCall(binding, log, transport, deps);
    group = true;
  } else {
    const header: ChatHeader = {
      format: CHAT_FORMAT,
      id,
      createdAt: Date.now(),
      participants: [host],
    };
    const log = memoryCallLog(header);
    call =
      binding === undefined
        ? { log, transport, deps, close: () => {} }
        : bindCall(binding, log, transport, deps);
  }
  const realtime = !group && select("realtime") !== null;
  try {
    return await runVoiceCall(
      call.transport,
      {
        id,
        host,
        viewer: admission.user,
        log: call.log,
        greet: !group,
        realtime,
        ...(group ? { group } : {}),
      },
      call.deps,
      NO_SHUTDOWN,
    );
  } finally {
    call.close();
  }
}
