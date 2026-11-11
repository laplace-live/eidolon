import { expect, test } from "bun:test";
import { packMsg, unpackMsg } from "../../src/speech/stream/msgpack.ts";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

test("each value packs in its smallest form, as @msgpack/msgpack packs it", () => {
  expect(hex(packMsg(null))).toBe("c0");
  expect(hex(packMsg(undefined))).toBe("c0");
  expect(hex(packMsg([true, false]))).toBe("92c3c2");
  expect(hex(packMsg([0, 127, 128, 255, 256, 65535, 65536]))).toBe(
    "97007fcc80ccffcd0100cdffffce00010000",
  );
  expect(hex(packMsg([2 ** 32]))).toBe("91cf0000000100000000");
  expect(hex(packMsg([-1, -32, -33, -128, -129, -32768, -32769, -(2 ** 31) - 1]))).toBe(
    "98ffe0d0dfd080d1ff7fd18000d2ffff7fffd3ffffffff7fffffff",
  );
  expect(hex(packMsg(1.5))).toBe("cb3ff8000000000000");
  expect(hex(packMsg("a".repeat(31))).slice(0, 2)).toBe("bf");
  expect(hex(packMsg("a".repeat(32))).slice(0, 4)).toBe("d920");
  expect(hex(packMsg("a".repeat(256))).slice(0, 6)).toBe("da0100");
  expect(hex(packMsg(new Uint8Array([1, 2])))).toBe("c4020102");
  const sixteen = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, i]));
  expect(hex(packMsg(sixteen)).slice(0, 6)).toBe("de0010");
  expect(hex(packMsg(Array.from({ length: 16 }, () => 0))).slice(0, 6)).toBe("dc0010");
});

test("what it packs comes back, keys in order and bytes as bytes", () => {
  const value = {
    event: "audio",
    audio: new Uint8Array([0, 255, 7]),
    nested: { list: [1, -2, 3.25, "三", null, false], big: 2 ** 40, low: -(2 ** 40) },
    text: "好".repeat(100),
  };
  const back = unpackMsg(packMsg(value)) as typeof value;
  expect(Object.keys(back)).toEqual(["event", "audio", "nested", "text"]);
  expect(back.audio).toBeInstanceOf(Uint8Array);
  expect(back).toEqual(value);
});

test("float32 reads; extension types, cut input and trailing bytes throw", () => {
  expect(unpackMsg(new Uint8Array([0xca, 0x3f, 0xc0, 0, 0]))).toBe(1.5);
  expect(() => unpackMsg(new Uint8Array([0xd4, 1, 2]))).toThrow(
    "unsupported MessagePack type 0xd4",
  );
  expect(() => unpackMsg(new Uint8Array([0xa3, 0x61]))).toThrow("truncated MessagePack");
  expect(() => unpackMsg(new Uint8Array([0xc0, 0xc0]))).toThrow("trailing bytes");
});

test("an array longer than its message throws before making room for it", () => {
  // A 5-byte array32 that claims 100 million items: room for them would be 800 MB.
  const before = process.memoryUsage().rss;
  expect(() => unpackMsg(new Uint8Array([0xdd, 0x05, 0xf5, 0xe1, 0x00]))).toThrow(
    "truncated MessagePack",
  );
  expect(process.memoryUsage().rss - before).toBeLessThan(100_000_000);
  expect(() => unpackMsg(new Uint8Array([0x93, 0x01, 0x02]))).toThrow("truncated MessagePack");
  expect(unpackMsg(new Uint8Array([0x92, 0x01, 0x02]))).toEqual([1, 2]);
});
