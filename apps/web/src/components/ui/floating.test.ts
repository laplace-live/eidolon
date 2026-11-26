import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

const seen = {
  popover: [] as Record<string, unknown>[],
  tooltip: [] as Record<string, unknown>[],
  menu: [] as Record<string, unknown>[],
  submenu: [] as Record<string, unknown>[],
};

function slot(name: keyof typeof seen) {
  return (props: Record<string, unknown> & { readonly children?: ReactNode }) => {
    seen[name].push(props);
    return createElement("div", { "data-mock": name }, props.children);
  };
}

const pass = ({ children }: { readonly children?: ReactNode }) => children ?? null;

vi.doMock("radix-ui", () => ({
  Popover: { Portal: pass, Content: slot("popover") },
  Tooltip: { Portal: pass, Content: slot("tooltip"), Arrow: () => null },
  DropdownMenu: {
    Portal: pass,
    Content: slot("menu"),
    SubContent: slot("submenu"),
  },
}));

const { PopoverContent } = await import("./popover");
const { TooltipContent } = await import("./tooltip");
const { DropdownMenuContent, DropdownMenuSubContent } = await import("./dropdown-menu");

test("popovers, tooltips and menus keep a margin from the window edge unless told otherwise", () => {
  renderToStaticMarkup(
    createElement(
      "div",
      null,
      createElement(PopoverContent, { className: "w-80" }, "Why"),
      createElement(PopoverContent, { collisionPadding: 16 }, "Custom"),
      createElement(TooltipContent, null, "Hint"),
      createElement(DropdownMenuContent, null, "Items"),
      createElement(DropdownMenuSubContent, null, "More"),
    ),
  );

  expect(seen.popover?.[0]?.collisionPadding).toBe(8);
  expect(seen.popover?.[0]?.className).toContain("max-w-[calc(100vw-1rem)]");
  expect(seen.popover?.[0]?.className).toContain("w-80");
  expect(seen.popover?.[1]?.collisionPadding).toBe(16);
  expect(seen.tooltip?.[0]?.collisionPadding).toBe(8);
  expect(seen.menu?.[0]?.collisionPadding).toBe(8);
  expect(seen.submenu?.[0]?.collisionPadding).toBe(8);
});
