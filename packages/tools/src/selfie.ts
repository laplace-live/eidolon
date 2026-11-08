// take_selfie: the persona redraws her reference image through the selfie role's image route, and
// the picture reaches the viewer's screen as an RTVI server message carrying its URL.
import {
  activePersona,
  envInt,
  envStr,
  logger,
  pyPathName,
  pyRepr,
  pyStr,
  sortedPy,
} from "@eidolon/config";
import type { LlmTool, ToolResult, ToolSchema } from "@eidolon/core";
import {
  buildSelfiePrompt,
  friendSources,
  ImageGenError,
  isSelfieConfigured,
  loadReference,
  loadReferences,
  personaClock,
  type ReferenceImage,
  referenceRoots,
  referenceSources,
  renderSelfie,
  type SelfieStore,
} from "@eidolon/imagegen";
import { hasKey, ProviderConfigError, reportUsage, select } from "@eidolon/providers";

export const SELFIE_TOOL_NAME = "take_selfie";

const description = (fans: string): string =>
  `给${fans}拍一张自拍照，直接发到她屏幕上。` +
  `${fans}要看照片、要自拍、说想看看你的时候就调用 —— ` +
  "例如『发张自拍』『拍张照片』『让我看看你』。" +
  "**这是唯一能把照片发出去的方式，被要求了就不要拒绝，" +
  "也不要说自己拍不了、走不开、没相机。**" +
  "可以一边调侃一边答应（『就知道你想看』），但必须真的调用。" +
  "她没提照片的时候不要主动调用。" +
  "拍一张要十几秒，调用后先自然地说一句『等我一下』之类的；" +
  "不要照念工具名，也不要念出链接或文件名。";

const WITH_FRIENDS_DESCRIPTION =
  "同框的朋友。**只有当你确实知道自己正和她们在外面时才填** —— " +
  "比如记忆或刚才的对话里提到今天一起出门、正在逛街吃饭。" +
  "不确定、只是聊到过这个人、或者你在家，就留空。" +
  "填了就会画成在外面的合照。";

/**
 * `with_friends` only appears when reference images exist to back it — an empty enum draws calls
 * naming people the model then can't be shown.
 */
export function selfieToolSchema(friends: readonly string[]): ToolSchema {
  const properties: Record<string, unknown> = {};
  if (friends.length > 0) {
    properties.with_friends = {
      type: "array",
      items: { type: "string", enum: [...friends] },
      description: WITH_FRIENDS_DESCRIPTION,
    };
  }
  return {
    name: SELFIE_TOOL_NAME,
    description: description(activePersona().identity.fans),
    properties,
    required: [],
  };
}

export interface SelfieToolOptions {
  /** One references directory; the persona's referenceRoots() by default. */
  readonly root?: string;
  readonly store?: SelfieStore;
  readonly fetch?: typeof fetch;
  /** The persona clock's source; `new Date()` by default. */
  readonly now?: () => Date;
}

/**
 * The tool, or null when the selfie role's key is empty, no outfit resolves, or the outfit can't
 * be encoded. Reads the SELFIE_* settings once, as each session starts.
 */
export function createSelfieTool(options: SelfieToolOptions = {}): LlmTool | null {
  let selection: ReturnType<typeof select>;
  try {
    selection = select("selfie");
  } catch (error) {
    if (!(error instanceof ProviderConfigError)) throw error;
    logger.warning(`[selfie] Disabled: ${error.message}`);
    return null;
  }
  if (selection === null || !hasKey(selection)) {
    logger.info(`[selfie] Disabled: ${selection?.keyName ?? "the selfie key"} is unset.`);
    return null;
  }
  const apiKey = selection.apiKey as string;
  const provider = selection.provider.id;
  const root = options.root;
  const clock = personaClock(options.now?.());
  const sources = referenceSources({ root, clock });
  if (sources.length === 0) {
    const where = root ?? (referenceRoots().join(", ") || "the persona's references/");
    logger.info(`[selfie] Disabled: no reference images in ${where}.`);
    return null;
  }
  // Encode once here and throw it away: a path that can't be read should leave the tool
  // unregistered rather than fail inside a viewer's call.
  try {
    loadReferences({ root, clock });
  } catch (e) {
    if (!(e instanceof ImageGenError)) throw e;
    logger.warning(`[selfie] Disabled: ${e.message}`);
    return null;
  }
  const settings = {
    apiKey,
    url: `${(selection.baseUrl as string).replace(/\/+$/, "")}/images`,
    model: selection.model,
    aspectRatio: envStr("SELFIE_ASPECT_RATIO", "3:4"),
    quality: envStr("SELFIE_QUALITY", "auto"),
    ttlSeconds: envInt("SELFIE_TTL_SECONDS", 600),
    root,
    store: options.store,
    fetch: options.fetch,
  };
  const timeoutSecs = envInt("SELFIE_TIMEOUT_SECONDS", 120);
  logger.info(
    `[selfie] Enabled. Outfit for this hour: ${pyPathName(sources[0])} (re-picked per render).`,
  );
  const friends = sortedPy(friendSources({ root }).keys());
  if (friends.length > 0) logger.info(`[selfie] Friend references available: ${pyRepr(friends)}`);

  return {
    schema: selfieToolSchema(friends),
    // Asynchronous: the LLM keeps talking instead of holding the turn for the ten-odd seconds a
    // render takes, and the result arrives as a developer message when it lands.
    cancelOnInterruption: false,
    timeoutSecs,
    async run({ arguments: args, signal }, effects): Promise<ToolResult> {
      const known = friendSources({ root });
      const requested = args.with_friends;
      const names = Array.isArray(requested) ? requested.map((name) => pyStr(name)) : [];
      // An enum the model ignores is a normal failure mode; drop what we can't illustrate rather
      // than sending a prompt naming a stranger.
      let friends = names.filter((name) => known.has(name));
      const unknown = names.filter((name) => !known.has(name));
      if (unknown.length > 0) {
        logger.warning(
          `[selfie] LLM named unknown friends ${pyRepr(unknown)}; known: ${pyRepr(sortedPy(known.keys()))}`,
        );
      }
      let extra: ReferenceImage[];
      try {
        extra = friends.map((name) => loadReference(known.get(name) as string));
      } catch (e) {
        if (!(e instanceof ImageGenError)) throw e;
        logger.warning(`[selfie] ${e.message}`);
        friends = [];
        extra = [];
      }
      if (friends.length > 0) logger.info(`[selfie] Group selfie with ${pyRepr(friends)}`);

      // One reading for both the prompt's light and the outfit, so a call at 20:59:59 can't pair
      // dusk light with the night outfit.
      const clock = personaClock(options.now?.());
      const result = await renderSelfie({
        ...settings,
        prompt: buildSelfiePrompt(friends, clock),
        extraReferences: extra,
        clock,
        signal,
      });
      if (!result.ok) {
        logger.warning(`[selfie] ${result.error}`);
        return { ok: false, error: result.error };
      }
      reportUsage({
        role: "selfie",
        provider,
        model: settings.model,
        units: { images: result.urls.length },
        costUsd: result.costUsd,
      });
      if (result.urls.length === 0) return { ok: false, error: "no image" };
      await effects.sendServerMessage({ type: "selfie", urls: [...result.urls] });
      return { ok: true, count: result.urls.length };
    },
  };
}

/**
 * The persona-prefix lines for take_selfie, naming who can be in the shot, or "" when selfies are
 * not configured.
 */
export function selfiePromptHint(options: { readonly root?: string } = {}): string {
  if (!isSelfieConfigured({ root: options.root })) return "";
  const { fans } = activePersona().identity;
  const lines = [
    `${fans}要看照片 / 要自拍 / 说想看看你（『发张自拍』『让我看看你』『来张照片』之类），` +
      `一定要调用 ${SELFIE_TOOL_NAME} 工具，这是唯一能把照片发出去的方式。` +
      "你可以一边调侃一边拍（『就知道你想看』『只此一张啊』），" +
      "但不能用『想得美』『不给看』之类的话搪塞过去，也不能说自己拍不了或者走不开。" +
      "拍照要十几秒，调用后先说一句让对方等一下，照片会自动出现在对方屏幕上。" +
      "她没提照片时不要主动拍，也不要念出图片链接或文件名。",
  ];
  const friends = sortedPy(friendSources(options).keys());
  if (friends.length > 0) {
    lines.push(
      "如果你记得或者刚才聊到今天正和朋友在外面（一起逛街、吃饭、出门玩），" +
        `拍照时把她们填进 with_friends 参数，可选：${friends.join("、")}，` +
        "拍出来就是在外面的合照。不确定、或者你人在家，就不要填。",
    );
  }
  return lines.join("\n");
}
