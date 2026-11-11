import { afterEach, beforeEach, expect, test } from "bun:test";
import { Meter, type Selection, select, setUsageSink, type UsageRecord } from "../src/index.ts";

const ENV: Readonly<Record<string, string>> = { SONIOX_API_KEY: "k", FISH_API_KEY: "k" };
const read = (name: string) => ENV[name];

function selection(role: "hearing" | "voice"): Selection {
  const selected = select(role, read);
  if (selected === null) throw new Error(`no ${role}`);
  return selected;
}

let records: UsageRecord[];
beforeEach(() => {
  records = [];
  setUsageSink((record) => records.push(record));
});
afterEach(() => setUsageSink(null));

test("audio is reported once 300 s have piled up, as the selection's use", () => {
  const meter = new Meter(selection("hearing"));
  meter.add({ audioSeconds: 299 });
  expect(records).toHaveLength(0);
  meter.add({ audioSeconds: 1.5 });
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    role: "hearing",
    provider: "soniox",
    model: "stt-rt-v5",
    units: { audioSeconds: 300.5 },
  });
  meter.flush();
  expect(records).toHaveLength(1);
});

test("text is reported once 2000 characters have piled up, with its bytes", () => {
  const meter = new Meter(selection("voice"));
  meter.add({ characters: 1999, bytes: 5997 });
  expect(records).toHaveLength(0);
  meter.add({ characters: 1, bytes: 3 });
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    role: "voice",
    provider: "fish",
    model: "drama-3",
    units: { characters: 2000, bytes: 6000 },
  });
});

test("flush reports what is left once, and nothing when nothing is", () => {
  const meter = new Meter(selection("voice"));
  meter.flush();
  meter.add({ characters: 3, bytes: 9 });
  meter.flush();
  meter.flush();
  expect(records.map((record) => record.units)).toEqual([{ characters: 3, bytes: 9 }]);
});

test("bytes alone are never reported", () => {
  const meter = new Meter(selection("voice"));
  meter.add({ bytes: 4096 });
  meter.flush();
  expect(records).toHaveLength(0);
});
