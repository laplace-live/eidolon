// A call hung up while her model list loads fetches nothing more: its file can be 200 MiB.
import { QueryClient } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import type { CharacterModels } from "@/lib/api";
import type { CastMember } from "./target";

const fetched: string[] = [];
let answerList: (list: CharacterModels) => void = () => {};
vi.doMock("@/lib/api", () => ({
  call: (route: string) => {
    fetched.push(route);
    return new Promise<CharacterModels>((resolve) => {
      answerList = resolve;
    });
  },
  bytes: (route: string) => {
    fetched.push(route);
    return Promise.resolve(new ArrayBuffer(0));
  },
}));
const { loadCastModel } = await import("./cast");

const MILKY: CastMember = {
  id: "milky-green",
  name: "明前奶绿",
  shortName: "奶绿",
  avatar: false,
  appearance: {
    model: {
      id: "tml",
      name: "TML",
      kind: "psd2live",
      sha256: "0".repeat(64),
      updatedAt: "2026-11-23T00:00:00.000Z",
    },
  },
};

test("a call hung up while her model list loads never fetches the model's file", async () => {
  const hangUp = new AbortController();
  const loading = loadCastModel(new QueryClient(), MILKY, {} as HTMLCanvasElement, hangUp.signal);
  await vi.waitFor(() => expect(fetched).toEqual(["GET /api/local/personas/:id/models"]));
  hangUp.abort();
  answerList({
    active: "tml",
    models: [{ id: "tml", sha256: "0".repeat(64) }],
  } as unknown as CharacterModels);
  await expect(loading).rejects.toThrow();
  expect(fetched).toEqual(["GET /api/local/personas/:id/models"]);
});
