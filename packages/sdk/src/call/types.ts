import type {
  BotCapabilities,
  BotOutputData,
  DeviceError,
  LLMFunctionCallInProgressData,
  LLMFunctionCallStartedData,
  LLMFunctionCallStoppedData,
  MediaState,
  MediaSupport,
  Participant,
  PipecatMetricsData,
  TranscriptData,
  TransportState,
  UnsupportedFeatureError,
  UserInputData,
} from "@pipecat-ai/client-js";
import type { ChatWindow, ParticipantId, WireEvent } from "../chat/types.ts";

export {
  type BotCapabilities,
  BotNotReadyError,
  type BotOutputData,
  ConnectionTimeoutError,
  DeviceError,
  type DeviceErrorDetails,
  type DeviceErrorReason,
  type DeviceErrorType,
  type DeviceState,
  type DeviceStatus,
  type LLMFunctionCallInProgressData,
  type LLMFunctionCallStartedData,
  type LLMFunctionCallStoppedData,
  LogLevel,
  type MediaState,
  type MediaSupport,
  MessageTooLargeError,
  type Participant,
  type PipecatMetricsData,
  RTVIError,
  RTVIEvent,
  type RTVIMessage,
  type SendTextOptions,
  type SpokenProgressData,
  type SpokenStatus,
  StartBotError,
  type Tracks,
  type TranscriptData,
  TransportStartError,
  type TransportState,
  UnsupportedFeatureError,
  type UserInputData,
  type UserInputType,
} from "@pipecat-ai/client-js";

/** Outbound Opus bitrate presets accepted by `requestData.audioQuality`, best to lowest. */
export const AUDIO_QUALITIES = ["best", "medium", "low", "lowest"] as const;

export type AudioQuality = (typeof AUDIO_QUALITIES)[number];

export function isAudioQuality(value: unknown): value is AudioQuality {
  return typeof value === "string" && (AUDIO_QUALITIES as readonly string[]).includes(value);
}

/** `requestData` for a standalone voice call outside a stored chat. */
export interface StandaloneOfferRequestData {
  readonly audioQuality?: AudioQuality;
  readonly loginSyncToken?: string;
  /** @deprecated Ignored by standalone `/api/offer`, which always uses the server's active persona. */
  readonly persona?: ParticipantId;
  readonly chat?: undefined;
  readonly chatId?: undefined;
}

/** `requestData` for a voice call inside a browser-stored stateless chat. */
export interface ChatOfferRequestData {
  readonly audioQuality?: AudioQuality;
  readonly loginSyncToken?: string;
  readonly chat: ChatWindow;
  readonly persona: ParticipantId;
  /** @deprecated Ignored by stateless `/api/offer`, which serves 1:1 in-chat calls only. */
  readonly group?: boolean;
}

/** `requestData` for a voice call inside the local app's server-stored chat. */
export interface LocalChatOfferRequestData {
  readonly audioQuality?: AudioQuality;
  readonly chatId: string;
  /** Required by local `/api/offer`, including when `group: true` (where it names the opening speaker). */
  readonly persona: ParticipantId;
  readonly group?: boolean;
}

export type OfferRequestData =
  | StandaloneOfferRequestData
  | ChatOfferRequestData
  | LocalChatOfferRequestData;

export interface EidolonConnectOptions {
  readonly endpoint: string | URL;
  readonly headers?: HeadersInit;
  readonly requestData?: OfferRequestData;
  readonly timeout?: number;
}

/** Server identity reported in `bot-ready`'s `about` payload. */
export interface EidolonBotAbout {
  readonly library: string;
  readonly library_version: string;
  readonly [field: string]: unknown;
}

export interface EidolonBotReadyData {
  readonly version: string;
  readonly about: EidolonBotAbout | null;
  readonly rawAbout: unknown;
  readonly capabilities?: BotCapabilities;
}

export interface EidolonErrorData {
  readonly error: string;
  readonly fatal: boolean;
}

export interface EidolonErrorMessage {
  readonly id: string;
  readonly type: string;
  readonly data: EidolonErrorData;
  readonly rawData: unknown;
}

/** Who a group call's server says is speaking as her audio begins. */
export interface CallSpeaker {
  readonly persona: ParticipantId;
  readonly name: string;
}

export interface SelfieServerMessage {
  readonly type: "selfie";
  /** Same-origin `/api/selfie/<id>` paths verified by `selfiePaths`. */
  readonly urls: readonly string[];
  readonly persona: ParticipantId | null;
}

export interface ChatLineServerMessage {
  readonly type: "chat-line";
  readonly event: WireEvent;
}

export interface SpeakerServerMessage {
  readonly type: "speaker";
  readonly speaker: CallSpeaker;
}

export interface UnknownServerMessage {
  readonly type: "unknown";
  readonly raw: unknown;
}

/** Discriminated union of every `server-message` payload Eidolon pushes over RTVI. */
export type EidolonServerMessage =
  | SelfieServerMessage
  | ChatLineServerMessage
  | SpeakerServerMessage
  | UnknownServerMessage;

export interface EidolonEvents {
  readonly connected: () => void;
  readonly disconnected: () => void;
  readonly transportStateChanged: (state: TransportState) => void;
  readonly botStarted: (botResponse: unknown) => void;
  readonly botConnected: (participant: Participant) => void;
  readonly botReady: (data: EidolonBotReadyData) => void;
  readonly botDisconnected: (participant: Participant) => void;
  readonly error: (message: EidolonErrorMessage) => void;
  readonly serverMessage: (message: EidolonServerMessage) => void;
  readonly serverResponse: (data: unknown) => void;
  readonly messageError: (message: EidolonErrorMessage) => void;
  readonly metrics: (data: PipecatMetricsData) => void;
  readonly botStartedSpeaking: () => void;
  readonly botStoppedSpeaking: () => void;
  readonly botInterrupted: () => void;
  readonly userStartedSpeaking: () => void;
  readonly userStoppedSpeaking: () => void;
  readonly userMuteStarted: () => void;
  readonly userMuteStopped: () => void;
  readonly userTranscript: (data: TranscriptData) => void;
  readonly userInput: (data: UserInputData) => void;
  readonly botOutput: (data: BotOutputData) => void;
  readonly botLlmStarted: () => void;
  readonly botLlmStopped: () => void;
  readonly botTtsStarted: () => void;
  readonly botTtsStopped: () => void;
  readonly llmFunctionCallStarted: (data: LLMFunctionCallStartedData) => void;
  readonly llmFunctionCallInProgress: (data: LLMFunctionCallInProgressData) => void;
  readonly llmFunctionCallStopped: (data: LLMFunctionCallStoppedData) => void;
  readonly participantConnected: (participant: Participant) => void;
  readonly participantLeft: (participant: Participant) => void;
  readonly trackStarted: (track: MediaStreamTrack, participant?: Participant) => void;
  readonly trackStopped: (track: MediaStreamTrack, participant?: Participant) => void;
  readonly localAudioLevel: (level: number) => void;
  readonly remoteAudioLevel: (level: number, participant: Participant) => void;
  readonly availableMicsUpdated: (mics: MediaDeviceInfo[]) => void;
  readonly availableSpeakersUpdated: (speakers: MediaDeviceInfo[]) => void;
  readonly micUpdated: (mic: MediaDeviceInfo) => void;
  readonly speakerUpdated: (speaker: MediaDeviceInfo) => void;
  readonly deviceError: (error: DeviceError) => void;
  readonly mediaStateUpdated: (mediaState: MediaState) => void;
  readonly mediaSupportUpdated: (mediaSupport: MediaSupport) => void;
  readonly unsupportedFeature: (error: UnsupportedFeatureError) => void;
}

export type EidolonEventName = keyof EidolonEvents;

export type EidolonEventHandler<E extends EidolonEventName> = EidolonEvents[E];

/** Erasable string constants matching `EidolonEventName` for callers that prefer named keys. */
export const EidolonEvent = {
  Connected: "connected",
  Disconnected: "disconnected",
  TransportStateChanged: "transportStateChanged",
  BotStarted: "botStarted",
  BotConnected: "botConnected",
  BotReady: "botReady",
  BotDisconnected: "botDisconnected",
  Error: "error",
  ServerMessage: "serverMessage",
  ServerResponse: "serverResponse",
  MessageError: "messageError",
  Metrics: "metrics",
  BotStartedSpeaking: "botStartedSpeaking",
  BotStoppedSpeaking: "botStoppedSpeaking",
  BotInterrupted: "botInterrupted",
  UserStartedSpeaking: "userStartedSpeaking",
  UserStoppedSpeaking: "userStoppedSpeaking",
  UserMuteStarted: "userMuteStarted",
  UserMuteStopped: "userMuteStopped",
  UserTranscript: "userTranscript",
  UserInput: "userInput",
  BotOutput: "botOutput",
  BotLlmStarted: "botLlmStarted",
  BotLlmStopped: "botLlmStopped",
  BotTtsStarted: "botTtsStarted",
  BotTtsStopped: "botTtsStopped",
  LLMFunctionCallStarted: "llmFunctionCallStarted",
  LLMFunctionCallInProgress: "llmFunctionCallInProgress",
  LLMFunctionCallStopped: "llmFunctionCallStopped",
  ParticipantConnected: "participantConnected",
  ParticipantLeft: "participantLeft",
  TrackStarted: "trackStarted",
  TrackStopped: "trackStopped",
  LocalAudioLevel: "localAudioLevel",
  RemoteAudioLevel: "remoteAudioLevel",
  AvailableMicsUpdated: "availableMicsUpdated",
  AvailableSpeakersUpdated: "availableSpeakersUpdated",
  MicUpdated: "micUpdated",
  SpeakerUpdated: "speakerUpdated",
  DeviceError: "deviceError",
  MediaStateUpdated: "mediaStateUpdated",
  MediaSupportUpdated: "mediaSupportUpdated",
  UnsupportedFeature: "unsupportedFeature",
} as const satisfies Readonly<Record<string, EidolonEventName>>;
