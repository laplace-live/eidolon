import { type Attachment, lineFilesOf } from "@eidolon/chat";
import { expect, test, vi } from "vitest";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
const { lineAttachments } = await import("./use-draft-files");

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
