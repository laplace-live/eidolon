import { useCallback, useEffect, useRef, useState } from "react";
import {
  usePipecatClient,
  usePipecatClientTransportState,
  usePipecatConversation,
} from "@pipecat-ai/client-react";

interface VoiceBotProps {
  /** Absolute or relative URL of the bot's `POST /api/offer` endpoint. */
  offerUrl: string;
}

const STATUS_LABEL: Record<string, string> = {
  disconnected: "Disconnected",
  initializing: "Initializing",
  initialized: "Ready",
  authenticating: "Authenticating",
  connecting: "Connecting",
  connected: "Connected",
  ready: "Live",
  disconnecting: "Disconnecting",
  error: "Error",
};

const ACTIVE_STATES = new Set([
  "initializing",
  "initialized",
  "authenticating",
  "connecting",
  "connected",
  "ready",
  "disconnecting",
]);

export function VoiceBot({ offerUrl }: VoiceBotProps) {
  // `usePipecatClient` returns `undefined` when the component renders
  // outside a `PipecatClientProvider`. App.tsx wraps us in one, so we
  // can safely treat the missing case as a programming error.
  const client = usePipecatClient();
  const transportState = usePipecatClientTransportState();
  const { messages } = usePipecatConversation();
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const isActive = ACTIVE_STATES.has(transportState);
  const isLive = transportState === "ready" || transportState === "connected";

  const handleConnect = useCallback(async () => {
    if (!client) return;
    setError(null);
    try {
      await client.connect({ connection_url: offerUrl });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, offerUrl]);

  const handleDisconnect = useCallback(async () => {
    if (!client) return;
    try {
      await client.disconnect();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  const handleToggleMute = useCallback(() => {
    if (!client) return;
    const next = !muted;
    client.enableMic(!next);
    setMuted(next);
  }, [client, muted]);

  // Auto-scroll the transcript as new messages arrive.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <main className="app">
      <header className="app__header">
        <h1>laplace-avatar</h1>
        <div className={`pill pill--${transportState}`}>
          <span className="pill__dot" />
          {STATUS_LABEL[transportState] ?? transportState}
        </div>
      </header>

      <section className="controls">
        {!isActive ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleConnect}
          >
            Connect
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={handleDisconnect}
            >
              Disconnect
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={!isLive}
              onClick={handleToggleMute}
              aria-pressed={muted}
            >
              {muted ? "Unmute mic" : "Mute mic"}
            </button>
          </>
        )}
      </section>

      {error ? <div className="error">{error}</div> : null}

      <section className="transcript" ref={transcriptRef}>
        {messages.length === 0 ? (
          <p className="transcript__empty">
            {isLive
              ? "Listening… say hi."
              : "Click Connect to start a conversation."}
          </p>
        ) : (
          messages.map((msg, i) => (
            <article
              key={`${msg.createdAt}-${i}`}
              className={`message message--${msg.role}`}
            >
              <span className="message__role">{msg.role}</span>
              <p className="message__text">
                {msg.parts?.map((part, j) => {
                  if (typeof part.text === "string") {
                    return <span key={j}>{part.text}</span>;
                  }
                  // BotOutputText → split by real-time speech progress.
                  if (
                    part.text &&
                    typeof part.text === "object" &&
                    "spoken" in part.text
                  ) {
                    const spoken = String(part.text.spoken ?? "");
                    const unspoken = String(part.text.unspoken ?? "");
                    return (
                      <span key={j}>
                        <span>{spoken}</span>
                        <span className="message__unspoken">{unspoken}</span>
                      </span>
                    );
                  }
                  return null;
                })}
              </p>
            </article>
          ))
        )}
      </section>

      <footer className="app__footer">
        Endpoint: <code>{offerUrl || "(via Vite proxy → :7860)"}</code>
      </footer>
    </main>
  );
}
