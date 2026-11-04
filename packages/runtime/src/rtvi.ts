import { RTVIProcessor } from "@pipedog/core/processors/frameworks/rtvi/processor";

/** Sent to the client in RTVI bot-ready `about`. */
// Keep in sync with pyproject.toml [project].version.
export const BOT_ABOUT = Object.freeze({
  library: "laplace-eidolon",
  library_version: "0.2.0",
} as const);

/** RTVIProcessor that brands the bot-ready `about` payload as ours. */
export class LaplaceRTVIProcessor extends RTVIProcessor {
  override async setBotReady(about: Record<string, unknown> | null = null): Promise<void> {
    await super.setBotReady(about && Object.keys(about).length > 0 ? about : { ...BOT_ABOUT });
  }
}
