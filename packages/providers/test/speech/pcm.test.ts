import { expect, test } from "bun:test";
import { bytesOfBase64, PcmBytes } from "../../src/speech/pcm.ts";
import { bytesOf } from "./fake.ts";

test("a sample split between chunks waits for its other byte", () => {
  const bytes = bytesOf([1, -1, 32767, -32768]);
  const pcm = new PcmBytes();
  expect([...pcm.push(bytes.subarray(0, 1))]).toEqual([]);
  expect([...pcm.push(bytes.subarray(1, 1))]).toEqual([]);
  expect([...pcm.push(bytes.subarray(1, 4))]).toEqual([1, -1]);
  expect([...pcm.push(bytes.subarray(4, 7))]).toEqual([32767]);
  expect([...pcm.push(bytes.subarray(7))]).toEqual([-32768]);
});

test("base64 to bytes", () => {
  expect([...bytesOfBase64(Buffer.from([1, 2, 255]).toString("base64"))]).toEqual([1, 2, 255]);
});
