# `@laplace.live/eidolon-sdk`

Browser TypeScript and React client SDK for [LAPLACE Eidolon](https://github.com/laplace-live/eidolon):

- **`@laplace.live/eidolon-sdk`** — `EidolonClient` (SmallWebRTC + 24 kHz PCM capture + typed RTVI events), `/api/ice-servers` and `/api/memories` clients, stateless `/api/chat/*` NDJSON streaming, window construction, Web Locks coordination, `BrowserChatStore` persistence contract, Fish Audio delivery-cue markup parser, and post-utterance wait watchdog.
- **`@laplace.live/eidolon-sdk/react`** — `EidolonClientProvider`, `EidolonClientAudio`, `useEidolonClient`, `useEidolonTransportState`, `useEidolonMicControl`, `useEidolonMediaState`, `useEidolonMediaTrack`, `useEidolonEvent`, `useEidolonConversation`, `useEidolonAudioLevel`, `useEidolonMicDevices`, `useEidolonNetworkInfo`, and `useEidolonWatchdog`.
- **`@laplace.live/eidolon-sdk/avatar`** — draws a persona's PSD2Live model (`.p2lrt`) on a WebGL canvas and moves it with a call: `AvatarStage`, `loadPsd2liveModel`, `inspectPsd2liveRig`, `resolveSetup`, the direction reducer `direct` / `directionOf` (mood from her cues, speaking, listening, gestures), `moodTags`, `MouthMeter` (lip sync from the bot track), and the framing helpers `bustBox`, `companionBox` and `viewFor`. It ships PSD2Live's runtime as `dist/avatar/wasm/p2l_runtime.wasm`.

## Install

```bash
pnpm add @laplace.live/eidolon-sdk
```

React bindings require `react >= 18` when importing `@laplace.live/eidolon-sdk/react`.

The avatar entry needs WebGL and a page whose CSP allows `'wasm-unsafe-eval'` in `script-src`.
Bundlers that resolve `new URL("…", import.meta.url)` (Vite, webpack 5) ship its runtime by
themselves; elsewhere, pass the runtime's URL, bytes or compiled module as `runtime`.

## Which bot to point it at

A bot in production mode (`pnpm dev` or `pnpm start` in an Eidolon checkout, or its Docker
image) answers every origin unless `PIPECAT_ALLOWED_ORIGINS` narrows it. Eidolon's local app
(`pnpm app`, `pnpm local`, or the `eidolon` command) refuses other sites' API calls with a
403 until `EIDOLON_LOCAL_ALLOWED_ORIGINS` lists your site's origin, such as
`http://localhost:3000`; restart it after setting that. Text chats also need `EIDOLON_CHAT_SECRET`
set on the bot; without it the chat probe reports `"off"`.

## Voice call quick start

```tsx
import { EidolonClient } from "@laplace.live/eidolon-sdk";
import {
  EidolonClientAudio,
  EidolonClientProvider,
  useEidolonClient,
  useEidolonConversation,
  useEidolonTransportState,
} from "@laplace.live/eidolon-sdk/react";
import { useEffect, useState } from "react";

function CallControls({ baseUrl }: { baseUrl: string }) {
  const client = useEidolonClient();
  const state = useEidolonTransportState();
  const { messages } = useEidolonConversation();

  const dial = async () => {
    await client.refreshIceServers(baseUrl);
    await client.connect({
      endpoint: `${baseUrl}/api/offer`,
      requestData: { audioQuality: "medium" },
    });
  };

  return (
    <div>
      <button type="button" onClick={() => void dial()}>
        Call ({state})
      </button>
      <button type="button" onClick={() => void client.disconnect()}>
        Hang Up
      </button>
      <pre>{JSON.stringify(messages, null, 2)}</pre>
    </div>
  );
}

export function App() {
  // EidolonClient reads `window` when constructed: create it in the browser, never while server rendering.
  const [client, setClient] = useState<EidolonClient | null>(null);
  useEffect(() => setClient(new EidolonClient()), []);
  if (client === null) return null;
  return (
    <EidolonClientProvider client={client}>
      <CallControls baseUrl="http://127.0.0.1:7860" />
      <EidolonClientAudio />
    </EidolonClientProvider>
  );
}
```

## Avatar quick start

```ts
import {
  AvatarStage,
  bustBox,
  direct,
  directionOf,
  type DirectionEvent,
  directionState,
  loadPsd2liveModel,
  MouthMeter,
  resolveSetup,
} from "@laplace.live/eidolon-sdk/avatar";

const stage = new AvatarStage(canvas, { onError: () => showHerPicture() });
const model = await loadPsd2liveModel(canvas, new Uint8Array(await rigResponse.arrayBuffer()));
stage.show(model, resolveSetup(model.inventory));
const character = model.bounds(null);
if (character !== null) stage.frame(bustBox(model.bounds("HitAreaHead"), character));

// Each call event goes through direct(), with a tick every 100 ms; the stage follows the latest.
let state = directionState();
const step = (event: DirectionEvent) => {
  state = direct(state, event);
  stage.direct(directionOf(state));
};
client.on("botStartedSpeaking", () => step({ type: "bot-started-speaking", at: performance.now() }));
setInterval(() => step({ type: "tick", at: performance.now() }), 100);

// Her mouth follows the bot's track; make the AudioContext in the click that starts the call.
stage.mouth(new MouthMeter(botTrack, { context: audioContext }));
```

## License

AGPL-3.0-only. See [LICENSE](./LICENSE).

The avatar entry includes PSD2Live's web player, ported to TypeScript, and its runtime, both MIT:
see [LICENSE-psd2live](./LICENSE-psd2live) and [THIRD_PARTY.md](./THIRD_PARTY.md).
