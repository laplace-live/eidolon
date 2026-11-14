import { expect, test } from "bun:test";
import { selfiePaths, selfiePersona, speakerOf } from "../src/index.ts";

const ID = "Qm9vdHN0cmFwLWlkLTE2Yg";

test("keeps the bot's same-origin selfie paths", () => {
  const urls = [`/api/selfie/${ID}.png`, `/api/selfie/${ID}.webp`, `/api/selfie/${ID}`];
  expect(selfiePaths({ type: "selfie", urls })).toEqual(urls);
});

test("drops anything that could load from elsewhere or reach another route", () => {
  const urls = [
    `https://example.com/api/selfie/${ID}.png`,
    `//example.com/api/selfie/${ID}.png`,
    `/api/selfie/../local/status`,
    `/api/selfie/${ID}%2f..`,
    `/api/selfie/${ID}.png?x=1`,
    `/api/selfie/${ID}.png#x`,
    `/api/selfie/a/b.png`,
    `/api/selfie/`,
    `/api/selfie/${ID}.tar.gz`,
    `\\/api/selfie/${ID}.png`,
    `javascript:alert(1)`,
    `data:image/png;base64,AAAA`,
    ` /api/selfie/${ID}.png`,
    `/api/selfie/${ID}.png\n`,
    42,
    null,
  ];
  expect(selfiePaths({ type: "selfie", urls })).toEqual([]);
});

test("other server messages carry no selfies", () => {
  expect(selfiePaths({ type: "voice", urls: [`/api/selfie/${ID}.png`] })).toEqual([]);
  expect(selfiePaths({ type: "selfie", urls: `/api/selfie/${ID}.png` })).toEqual([]);
  expect(selfiePaths({ type: "selfie" })).toEqual([]);
  expect(selfiePaths(null)).toEqual([]);
  expect(selfiePaths("selfie")).toEqual([]);
});

test("a group call's selfie names whose photo it is", () => {
  const urls = [`/api/selfie/${ID}.png`];
  expect(selfiePersona({ type: "selfie", urls, persona: "mint" })).toBe("mint");
  expect(selfiePersona({ type: "selfie", urls })).toBeNull();
  expect(selfiePersona({ type: "selfie", urls, persona: "" })).toBeNull();
  expect(selfiePersona({ type: "selfie", urls, persona: 7 })).toBeNull();
  expect(selfiePersona(null)).toBeNull();
});

test("speakerOf reads the group call's label and nothing else", () => {
  expect(speakerOf({ type: "speaker", persona: "mint", name: "薄荷" })).toEqual({
    persona: "mint",
    name: "薄荷",
  });
  expect(speakerOf({ type: "speaker", persona: "mint", name: " " })).toEqual({
    persona: "mint",
    name: "mint",
  });
  expect(speakerOf({ type: "speaker", persona: "mint" })).toEqual({
    persona: "mint",
    name: "mint",
  });
  expect(speakerOf({ type: "speaker", persona: "", name: "薄荷" })).toBeNull();
  expect(speakerOf({ type: "speaker", persona: 7, name: "薄荷" })).toBeNull();
  expect(speakerOf({ type: "selfie", urls: ["/api/selfie/a.png"], persona: "mint" })).toBeNull();
  expect(speakerOf(null)).toBeNull();
  expect(speakerOf("speaker")).toBeNull();
});
