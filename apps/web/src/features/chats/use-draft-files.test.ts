import { type Attachment, lineFilesOf } from "@eidolon/chat";
import { expect, test, vi } from "vitest";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
const { lineAttachments, pickedFiles } = await import("./use-draft-files");

const shot: Attachment = { kind: "image", name: `${"a".repeat(64)}.png`, mime: "image/png" };
const notes: Attachment = {
  kind: "file",
  name: `${"b".repeat(64)}.txt`,
  mime: "text/plain",
  filename: "notes.md",
};
const draft = (key: number, attachment: Attachment | null) => ({
  key,
  filename: `file-${key}.png`,
  preview: null,
  attachment,
});

test("a file picked twice goes once, as POST messages takes a line's files", () => {
  const sent = lineAttachments([draft(1, shot), draft(2, notes), draft(3, shot)]);
  expect(sent).toEqual([shot, notes]);
  expect(lineFilesOf(sent)).not.toBeNull();
});

test("a file still uploading goes with no line", () => {
  expect(lineAttachments([draft(1, null), draft(2, notes)])).toEqual([notes]);
});

test("a picked file of a kind a line can't take leaves its room to the rest", () => {
  const pdf = new File(["%PDF"], "paper.pdf", { type: "application/pdf" });
  const pngs = ["a", "b", "c"].map((name) => new File(["x"], `${name}.png`, { type: "image/png" }));
  const { taken, unsupported, over } = pickedFiles([pdf, ...pngs], 3);
  expect(taken.map(({ file, kind }) => [file.name, kind])).toEqual([
    ["a.png", "image"],
    ["b.png", "image"],
    ["c.png", "image"],
  ]);
  expect([unsupported.map((file) => file.name), over]).toEqual([["paper.pdf"], false]);
  expect(pickedFiles(pngs, 2).over).toBe(true);
});
