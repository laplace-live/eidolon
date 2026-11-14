# `@laplace.live/eidolon-sdk`

Browser TypeScript and React client SDK for [LAPLACE Eidolon](https://github.com/laplace-live/eidolon):

- **`@laplace.live/eidolon-sdk`** — `EidolonClient` (SmallWebRTC + 24 kHz PCM capture + typed RTVI events), `/api/ice-servers` and `/api/memories` clients, stateless `/api/chat/*` NDJSON streaming, window construction, Web Locks coordination, `BrowserChatStore` persistence contract, Fish Audio delivery-cue markup parser, and post-utterance wait watchdog.
- **`@laplace.live/eidolon-sdk/react`** — `EidolonClientProvider`, `EidolonClientAudio`, `useEidolonClient`, `useEidolonTransportState`, `useEidolonMicControl`, `useEidolonMediaState`, `useEidolonMediaTrack`, `useEidolonEvent`, `useEidolonConversation`, `useEidolonAudioLevel`, `useEidolonMicDevices`, `useEidolonNetworkInfo`, and `useEidolonWatchdog`.

## Install

```bash
bun add @laplace.live/eidolon-sdk
```

React bindings require `react >= 18` when importing `@laplace.live/eidolon-sdk/react`.

## Which bot to point it at

A bot in production mode (`bun run dev` or `bun run start` in an Eidolon checkout, or its Docker
image) answers every origin unless `PIPECAT_ALLOWED_ORIGINS` narrows it. Eidolon's local app
(`bun run app`, `bun run local`, or the `eidolon` command) refuses other sites' API calls with a
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

## License

AGPL-3.0-only. See [LICENSE](./LICENSE).
