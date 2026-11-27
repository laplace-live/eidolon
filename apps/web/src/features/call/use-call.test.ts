import type { EidolonConnectOptions } from "@laplace.live/eidolon-sdk";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { EXPECTED_HOST_HEADER } from "../../../../bot/src/local/api.ts";
import {
  bumpHostMutationEpoch,
  resetExpectedSubspaceHost,
  setExpectedSubspaceHost,
  subscribeExpectedHostConflict,
} from "../../lib/api";
import { keepProof } from "../../lib/proof";
import { type MountedRoot, mountFakeDom } from "../../test/fake-dom";
import type { Call } from "./use-call";

let probeMicMock = vi.fn<() => Promise<null>>(() => Promise.resolve(null));
const fetchIceMock = vi.fn<(host?: string) => Promise<RTCIceServer[]>>(() => Promise.resolve([]));
const connectMock = vi.fn<(options: EidolonConnectOptions) => Promise<void>>(() =>
  Promise.resolve(),
);
const disconnectMock = vi.fn<() => Promise<void>>(() => Promise.resolve());

vi.doMock("./media", () => ({
  deviceProblemOf: () => ({ kind: "unknown", message: "mic error" }),
  probeMic: () => probeMicMock(),
}));

vi.doMock("@laplace.live/eidolon-sdk", async () => {
  const actual = await vi.importActual<typeof import("@laplace.live/eidolon-sdk")>(
    "@laplace.live/eidolon-sdk",
  );
  class MockEidolonClient {
    on() {
      return () => {};
    }
    enableMic() {}
    connect(options: EidolonConnectOptions) {
      return connectMock(options);
    }
    disconnect() {
      return disconnectMock();
    }
    sendText() {
      return Promise.resolve();
    }
  }
  return {
    ...actual,
    EidolonClient: MockEidolonClient,
  };
});

const realSignalling = await import("./signalling");
vi.doMock("./signalling", () => ({
  fetchIceServers: (expectedHost?: string) => {
    fetchIceMock(expectedHost);
    return realSignalling.fetchIceServers(expectedHost);
  },
  offerOptions: realSignalling.offerOptions,
}));

const { useCall } = await import("./use-call");
const { CallSignals } = await import("./signals");

describe("useCall host pinning and cancellation", () => {
  let mounted: MountedRoot | null = null;

  afterEach(async () => {
    resetExpectedSubspaceHost();
    vi.restoreAllMocks();
    probeMicMock.mockReset();
    fetchIceMock.mockReset();
    connectMock.mockReset();
    disconnectMock.mockReset();
    if (mounted !== null) {
      const current = mounted;
      mounted = null;
      await current.unmount();
    }
  });

  test("cancels dialing while probeMic awaits if host switches via bumpHostMutationEpoch", async () => {
    keepProof("proof-use-call-cancel");
    setExpectedSubspaceHost("srv_before");
    let resolveMic!: (problem: null) => void;
    probeMicMock = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          resolveMic = resolve;
        }),
    );

    let callHandle!: Call;
    const signals = new CallSignals();
    function Harness() {
      callHandle = useCall(signals);
      return null;
    }

    mounted = await mountFakeDom(createElement(Harness));
    await mounted.act(() => {
      callHandle.start();
    });
    expect(callHandle.phase.name).toBe("starting");

    await mounted.act(() => {
      bumpHostMutationEpoch();
    });
    expect(callHandle.phase.name).toBe("ended");

    await mounted.act(async () => {
      resolveMic(null);
      await Promise.resolve();
    });
    expect(fetchIceMock).not.toHaveBeenCalled();
    expect(connectMock).not.toHaveBeenCalled();
    signals.close();
  });

  test("pins captured dial host on offerOptions when host changes before connect, and notifies on 409", async () => {
    keepProof("proof-use-call-pin");
    setExpectedSubspaceHost("srv_dial");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ iceServers: [] }));
    let resolveMic!: (problem: null) => void;
    probeMicMock = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          resolveMic = resolve;
        }),
    );
    const conflictError = Object.assign(new Error("Host changed"), { status: 409 });
    connectMock.mockRejectedValueOnce(conflictError);

    const onConflict = vi.fn();
    const unsub = subscribeExpectedHostConflict(onConflict);

    let callHandle!: Call;
    const signals = new CallSignals();
    function Harness() {
      callHandle = useCall(signals);
      return null;
    }

    try {
      mounted = await mountFakeDom(createElement(Harness));
      await mounted.act(() => {
        callHandle.start();
      });

      // Even if active host header updates externally before offer submits (without epoch bump yet),
      // the dial attempt still pins the originally selected server and triggers 409 handling.
      setExpectedSubspaceHost("srv_other");
      await mounted.act(async () => {
        resolveMic(null);
        await vi.waitFor(() => {
          expect(connectMock).toHaveBeenCalledTimes(1);
        });
      });

      expect(fetchIceMock).toHaveBeenCalledWith("srv_dial");
      const sentHeaders = new Headers(connectMock.mock.calls[0]?.[0]?.headers);
      expect(sentHeaders.get(EXPECTED_HOST_HEADER)).toBe("srv_dial");
      expect(onConflict).toHaveBeenCalledTimes(1);
      expect(callHandle.phase).toMatchObject({
        name: "ended",
        end: { kind: "connect", status: 409 },
      });
    } finally {
      unsub();
      signals.close();
    }
  });
});
