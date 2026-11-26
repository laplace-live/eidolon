import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { avatarChanged } from "@/components/avatar/version";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";
import type { ChatPersona } from "./persona";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);

const { ChatAvatar, groupAvatarRows } = await import("./participants");

function persona(id: string, fields: Partial<ChatPersona> = {}): ChatPersona {
  return {
    id,
    name: `Persona ${id}`,
    shortName: id.toUpperCase(),
    avatar: true,
    appearance: { model: null },
    ...fields,
  };
}

describe("groupAvatarRows", () => {
  test("partitions 0 through 9+ items into WeChat-style centered rows", () => {
    const shapes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11].map((count) => {
      const items = Array.from({ length: count }, (_, i) => i + 1);
      return groupAvatarRows(items).map((row) => row.length);
    });
    expect(shapes).toEqual([
      [],
      [1],
      [2],
      [1, 2],
      [2, 2],
      [2, 3],
      [3, 3],
      [1, 3, 3],
      [2, 3, 3],
      [3, 3, 3],
      [3, 3, 3],
    ]);
    const capped = groupAvatarRows([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(capped.flat()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("ChatAvatar", () => {
  test("renders nothing for zero personas and circular PersonaAvatar for a single persona", () => {
    expect(renderToStaticMarkup(createElement(ChatAvatar, { personas: [] }))).toBe("");

    const single = renderToStaticMarkup(
      createElement(ChatAvatar, { personas: [persona("milky")] }),
    );
    expect(single).toContain('data-slot="avatar"');
    expect(single).toContain("rounded-full");
    expect(single).not.toContain('data-slot="group-avatar"');
  });

  test("renders a rounded-square 2x2 grid for 4 personas with image and single-grapheme fallbacks", () => {
    const list = [
      persona("a", { avatar: true }),
      persona("b", { avatar: false, shortName: "奶绿" }),
      persona("c", { avatar: false, shortName: " Rin " }),
      persona("d", { avatar: true }),
    ];
    const html = renderToStaticMarkup(createElement(ChatAvatar, { personas: list }));
    expect(html).toContain('data-slot="group-avatar"');
    expect(html).toContain("rounded-[6px]");
    expect(html).toContain("p-px");
    expect(html).toContain("gap-px");
    expect(html).not.toContain('data-slot="avatar"');
    expect(html.match(/data-slot="group-avatar-tile"/g)).toHaveLength(4);
    expect(html.match(/size-\[14\.5px\] rounded-\[2px\]/g)).toHaveLength(4);
    expect(html).toContain('src="/api/local/personas/a/avatar"');
    expect(html).toContain(
      '<img src="/api/local/personas/d/avatar" alt="" class="block size-full object-cover"/>',
    );
    expect(html).toContain(">奶<");
    expect(html).toContain(">R<");
  });

  test("renders compact size-[calc(28px/3)] tiles for 5 personas and caps at 9 tiles for 10 personas", () => {
    const five = Array.from({ length: 5 }, (_, i) => persona(`p${i + 1}`));
    const html5 = renderToStaticMarkup(createElement(ChatAvatar, { personas: five }));
    expect(html5.match(/data-slot="group-avatar-tile"/g)).toHaveLength(5);
    expect(html5.match(/size-\[calc\(28px\/3\)\] rounded-\[1\.5px\]/g)).toHaveLength(5);

    const ten = Array.from({ length: 10 }, (_, i) => persona(`q${i + 1}`));
    const html10 = renderToStaticMarkup(createElement(ChatAvatar, { personas: ten }));
    expect(html10.match(/data-slot="group-avatar-tile"/g)).toHaveLength(9);
    expect(html10).toContain('src="/api/local/personas/q9/avatar"');
    expect(html10).not.toContain('src="/api/local/personas/q10/avatar"');

    avatarChanged("q1");
    const updated = renderToStaticMarkup(createElement(ChatAvatar, { personas: ten }));
    expect(updated).toContain('src="/api/local/personas/q1/avatar?v=1"');
  });
});
