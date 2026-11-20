// The clock a test fakes: timers, Date and performance.now(). setImmediate stays real, since the
// tests turn the event loop with it, and a timer set before faking can still be cleared.
import { vi } from "vitest";

export function useFakeClock(): void {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
    shouldClearNativeTimers: true,
  });
}
