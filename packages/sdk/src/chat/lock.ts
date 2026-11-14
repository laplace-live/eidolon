/** Another turn, call or write holds the chat, or this browser lacks Web Locks. */
export class ChatBusyError extends Error {
  readonly chatId: string;

  constructor(chatId: string) {
    super(`chat ${chatId} is busy`);
    this.name = "ChatBusyError";
    this.chatId = chatId;
  }
}

function webLocks(): LockManager | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.locks;
}

/** Whether this browser has Web Locks, which chats need so two tabs never send one window at once. */
export function chatLocksAvailable(): boolean {
  return webLocks() !== undefined;
}

/**
 * Takes the chat's lock across this browser's tabs, resolving to its release. `wait` queues behind
 * the holder; otherwise a held lock or missing Web Locks rejects with `ChatBusyError`.
 */
export function holdChatLock(
  chatId: string,
  options: { readonly wait?: boolean } = {},
): Promise<() => void> {
  const locks = webLocks();
  if (locks === undefined) return Promise.reject(new ChatBusyError(chatId));
  return new Promise((resolve, reject) => {
    locks
      .request(
        `laplace-eidolon-chat:${chatId}`,
        { ifAvailable: !(options.wait ?? false) },
        (lock) => {
          if (lock === null) {
            reject(new ChatBusyError(chatId));
            return undefined;
          }
          return new Promise<void>((release) => resolve(() => release()));
        },
      )
      .catch(reject);
  });
}

export async function withChatLock<T>(
  chatId: string,
  run: () => Promise<T>,
  options: { readonly wait?: boolean } = {},
): Promise<T> {
  const release = await holdChatLock(chatId, options);
  try {
    return await run();
  } finally {
    release();
  }
}
