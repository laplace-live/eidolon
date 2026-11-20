import { type Attachment, type ChatEventOf, parseMentions } from "@eidolon/chat";
import { ProviderHttpError } from "@eidolon/providers";
import { describe, expect, test } from "vitest";
import {
  FileCache,
  filesNote,
  refusedImages,
  SHOWN_FILE_CHARS,
  SHOWN_IMAGES,
  showFiles,
  UNSEEN_IMAGE,
  UNSHOWN_IMAGE,
  withFilesNote,
  withoutImages,
} from "../src/seen.ts";

const signal = new AbortController().signal;

const image = (n: number, mime = "image/png"): Attachment => ({
  kind: "image",
  name: `${String(n).padStart(64, "0")}.png`,
  mime,
});
const text = (n: number, filename?: string): Attachment => ({
  kind: "file",
  name: `${String(n).padStart(64, "0")}.txt`,
  mime: "text/plain",
  ...(filename === undefined ? {} : { filename }),
});

/** Files by name, read as the chat's files/ would be, a PNG or text; `reads` counts each read. */
function chatFiles(bytes: Record<string, Uint8Array>) {
  const reads: string[] = [];
  const cache = new FileCache(async (name) => {
    reads.push(name);
    const found = bytes[name];
    if (found === undefined) throw new Error(`no ${name}`);
    return { bytes: found, mime: name.endsWith(".txt") ? "text/plain" : "image/png" };
  });
  return { cache, reads };
}

const encode = (value: string) => new TextEncoder().encode(value);
const url = (bytes: Uint8Array, mime = "image/png") =>
  `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

describe("showFiles", () => {
  test("a line's words come first, then its text files, then its images as image_url parts", async () => {
    const png = new Uint8Array([1, 2, 3]);
    const { cache } = chatFiles({ [image(1).name]: png, [text(2).name]: encode("第一章\n从前") });
    const shown = await showFiles(
      [
        { role: "system", content: "facts" },
        { role: "user", content: "看看", attachments: [text(2, "story.md"), image(1)] },
      ],
      cache,
      signal,
    );
    expect(shown).toEqual([
      { role: "system", content: "facts" },
      {
        role: "user",
        content: [
          { type: "text", text: '看看\n\n<file name="story.md">\n第一章\n从前\n</file>' },
          { type: "image_url", image_url: { url: url(png) } },
        ],
      },
    ]);
  });

  test("a line of images alone has no text part, and messages without files pass as they are", async () => {
    const png = new Uint8Array([9]);
    const { cache } = chatFiles({ [image(1).name]: png });
    const plain = { role: "user", content: "hi" };
    const shown = await showFiles(
      [plain, { role: "user", content: "", attachments: [image(1)] }],
      cache,
      signal,
    );
    expect(shown[0]).toBe(plain);
    expect(shown[1]).toEqual({
      role: "user",
      content: [{ type: "image_url", image_url: { url: url(png) } }],
    });
  });

  test("the newest images are shown, older ones past the budget read as a note", async () => {
    const bytes = Object.fromEntries(
      Array.from({ length: SHOWN_IMAGES + 2 }, (_, i) => [image(i).name, new Uint8Array([i])]),
    );
    const { cache } = chatFiles(bytes);
    const lines = Array.from({ length: SHOWN_IMAGES + 2 }, (_, i) => ({
      role: "user",
      content: `第${i}张`,
      attachments: [image(i)],
    }));
    expect(await showFiles(lines, cache, signal)).toEqual(
      lines.map(({ content }, i) =>
        i < 2
          ? { role: "user", content: `${content}${UNSHOWN_IMAGE}` }
          : {
              role: "user",
              content: [
                { type: "text", text: content },
                { type: "image_url", image_url: { url: url(new Uint8Array([i])) } },
              ],
            },
      ),
    );
  });

  test("a file that can't be read, or a turn with no reader, reads as its note", async () => {
    const { cache } = chatFiles({});
    expect(
      await showFiles(
        [{ role: "user", content: "看", attachments: [image(1), text(2, "a.md")] }],
        cache,
        signal,
      ),
    ).toEqual([{ role: "user", content: `看${UNSHOWN_IMAGE}（文件 a.md，这次没给你看）` }]);
    expect(
      await showFiles(
        [{ role: "user", content: "", attachments: [image(1)] }],
        new FileCache(undefined),
        signal,
      ),
    ).toEqual([{ role: "user", content: UNSHOWN_IMAGE }]);
  });

  test("an image goes as the type it was read as, as production reads a PNG made a JPEG", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
    const cache = new FileCache(async () => ({ bytes: jpeg, mime: "image/jpeg" }));
    expect(
      await showFiles([{ role: "user", content: "", attachments: [image(1)] }], cache, signal),
    ).toEqual([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: url(jpeg, "image/jpeg") } }],
      },
    ]);
  });

  test("a long text file is cut, saying how much is left, and each file is read once a turn", async () => {
    const long = "字".repeat(SHOWN_FILE_CHARS + 5);
    const { cache, reads } = chatFiles({ [text(1).name]: encode(long) });
    const lines = [{ role: "user", content: "", attachments: [text(1)] }];
    const [first] = (await showFiles(lines, cache, signal)) as { content: string }[];
    expect(first?.content).toBe(
      `<file name="file.txt">\n${"字".repeat(SHOWN_FILE_CHARS)}\n（后面还有 5 字，这次没给你看）\n</file>`,
    );
    await showFiles(lines, cache, signal);
    expect(reads).toEqual([text(1).name]);
  });
});

describe("withoutImages", () => {
  test("each image part becomes the note a mind that can't see reads, and the parts text again", () => {
    const plain = { role: "assistant", content: "嗯" };
    expect(
      withoutImages([
        plain,
        {
          role: "user",
          content: [
            { type: "text", text: "看" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
          ],
        },
      ]),
    ).toEqual([plain, { role: "user", content: `看${UNSEEN_IMAGE}` }]);
  });
});

describe("refusedImages", () => {
  test("reads a provider's refusal of image input, and nothing else", () => {
    const refusal = (status: number, message: string) =>
      refusedImages(new ProviderHttpError("OpenRouter", status, message));
    expect(refusal(404, "No endpoints found that support image input")).toBe(true);
    expect(refusal(422, "unknown variant `image_url`, expected `text`")).toBe(true);
    expect(refusal(400, "该模型不支持图片输入")).toBe(true);
    expect(refusal(400, "max_tokens is too large")).toBe(false);
    expect(refusal(429, "image rate limit")).toBe(false);
    expect(refusedImages(new Error("image"))).toBe(false);
  });
});

describe("the notes text alone reads", () => {
  test("a line's files leave a note after its words", () => {
    const line = {
      type: "message",
      seq: 1,
      at: 1,
      id: "m1",
      speaker: { kind: "user" },
      text: "看",
      attachments: [image(1), text(2, "a.md")],
    } satisfies ChatEventOf<"message">;
    expect(filesNote(line.attachments)).toBe("（图片）（文件 a.md）");
    expect(withFilesNote(line)).toBe("看（图片）（文件 a.md）");
    expect(withFilesNote({ ...line, speaker: { kind: "persona", id: "milky" } })).toBe("看");
  });

  test("a file named after a persona doesn't mention her", () => {
    const named = text(3, "@Bea和＠Bea.md");
    const bea = { id: "bea", name: "Bea", shortName: "Bea" };
    expect(filesNote([named])).toBe("（文件 Bea和Bea.md）");
    expect(parseMentions(filesNote([named]), [bea])).toEqual([]);
  });
});
