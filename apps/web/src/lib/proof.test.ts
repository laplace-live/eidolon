import { afterEach, expect, test } from "bun:test";
import { keepProof, proofHeaders } from "./proof";

/** A localStorage of one slot, whatever the key, that refuses every write unless `writable`. */
function fakeStorage(slot: { value: string | null }, writable: boolean): Storage {
  const storage: Pick<Storage, "getItem" | "setItem"> = {
    getItem: () => slot.value,
    setItem: (_key, value) => {
      if (!writable) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      slot.value = value;
    },
  };
  return storage as Storage;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

test("a proof storage refuses outranks the older one it still holds", () => {
  // Signed in, then local-token was deleted and the page signed in again with the new one.
  globalThis.localStorage = fakeStorage({ value: "proof-of-the-old-token" }, false);
  keepProof("proof-of-the-new-token");
  expect(proofHeaders()).toEqual({ "X-Eidolon-Proof": "proof-of-the-new-token" });
});

test("storage that takes the proof is read first, so another tab's sign-in reaches this one", () => {
  const slot: { value: string | null } = { value: null };
  globalThis.localStorage = fakeStorage(slot, true);
  keepProof("proof-of-this-tab");
  expect(slot.value).toBe("proof-of-this-tab");
  slot.value = "proof-of-another-tab";
  expect(proofHeaders()).toEqual({ "X-Eidolon-Proof": "proof-of-another-tab" });
});
