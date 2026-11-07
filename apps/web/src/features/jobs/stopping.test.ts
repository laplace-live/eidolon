import { expect, test } from "bun:test";
import { FORCE_STOP_AFTER_MS, forceStopIn, showsStop, stopOffer, stoppingSince } from "./stopping";

test("force stop waits 20 s from when the page first saw the job stopping", () => {
  const since = stoppingSince("job-a", 1_000);
  expect(since).toBe(1_000);
  // Seen again later, as after leaving the page and coming back, it keeps the first time.
  expect(stoppingSince("job-a", 15_000)).toBe(1_000);
  expect(stoppingSince("job-b", 15_000)).toBe(15_000);

  expect(FORCE_STOP_AFTER_MS).toBe(20_000);
  expect(forceStopIn(since, 1_000)).toBe(20_000);
  expect(forceStopIn(since, 20_999)).toBe(1);
  expect(forceStopIn(since, 21_000)).toBe(0);
  expect(forceStopIn(since, 60_000)).toBe(0);
});

test("only a job this server spawned is offered Cancel, then Force stop", () => {
  expect(stopOffer({ status: "running", stopping: false, signalable: true })).toBe("cancel");
  expect(stopOffer({ status: "running", stopping: true, signalable: true })).toBe("force-stop");
  // After a restart, an earlier server's job, stopping or not: either request would be a 409.
  expect(stopOffer({ status: "running", stopping: true, signalable: false })).toBe("earlier-run");
  expect(stopOffer({ status: "running", stopping: false, signalable: false })).toBe("earlier-run");
  for (const status of ["succeeded", "failed", "cancelled", "interrupted"] as const) {
    expect(stopOffer({ status, stopping: false, signalable: false })).toBeNull();
  }
});

test("a job stopping when the server restarted still shows it is stopping", () => {
  expect(showsStop({ status: "running", stopping: false, signalable: true })).toBe(true);
  expect(showsStop({ status: "running", stopping: true, signalable: true })).toBe(true);
  // The stop the earlier server sent on its way out: nothing to press, but it says so.
  expect(showsStop({ status: "running", stopping: true, signalable: false })).toBe(true);
  expect(showsStop({ status: "running", stopping: false, signalable: false })).toBe(false);
  for (const status of ["succeeded", "failed", "cancelled", "interrupted"] as const) {
    expect(showsStop({ status, stopping: false, signalable: true })).toBe(false);
  }
});
