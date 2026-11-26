import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { Router, type RouterOptions } from "wouter";
import type { LocalChatSummary, PersonasResponse, Status } from "@/lib/api";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
vi.doMock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

const { personasQuery } = await import("@/components/settings-form/queries");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { statusQuery } = await import("@/lib/query");
const { SidebarChats } = await import("./chat-list");
const { CHATS_ACTIVE_POLL_MS, CHATS_IDLE_POLL_MS, chatsPoll, chatsQuery } = await import(
  "./queries"
);

const PERSONA = {
  id: "milky-green",
  name: "明前奶绿",
  shortName: "奶绿",
  template: true,
  own: false,
  avatar: false,
  appearance: { model: null },
};

const PERSONAS: PersonasResponse = {
  active: PERSONA.id,
  personas: [PERSONA],
};

const STATUS = {
  persona: {
    id: PERSONA.id,
    name: PERSONA.name,
    shortName: PERSONA.shortName,
    avatar: false,
    appearance: { model: null },
  },
} as unknown as Status;

function renderSidebar(chats: readonly LocalChatSummary[], path = "/"): string {
  const client = new QueryClient();
  client.setQueryData(personasQuery.queryKey, PERSONAS);
  client.setQueryData(statusQuery.queryKey, STATUS);
  client.setQueryData(chatsQuery.queryKey, chats);
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n },
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          TooltipProvider,
          null,
          createElement(
            SidebarProvider,
            null,
            createElement(
              Router as FunctionComponent<RouterOptions>,
              { ssrPath: path },
              createElement(SidebarChats),
            ),
          ),
        ),
      ),
    ),
  );
}

function itemMarkup(markup: string, chatId: string): string {
  const href = `href="/chats/${chatId}"`;
  const at = markup.indexOf(href);
  expect(at).toBeGreaterThan(-1);
  const start = markup.lastIndexOf("<li ", at);
  const end = markup.indexOf("</li>", at);
  return markup.slice(start, end + 5);
}

describe("chatsPoll", () => {
  test("polls fast while any chat is active and slowly when all chats are idle", () => {
    expect(chatsPoll(undefined)).toBe(false);
    expect(chatsPoll([])).toBe(CHATS_IDLE_POLL_MS);
    expect(chatsPoll([{ active: false }, { active: false }])).toBe(CHATS_IDLE_POLL_MS);
    expect(chatsPoll([{ active: false }, { active: true }])).toBe(CHATS_ACTIVE_POLL_MS);
  });
});

describe("SidebarChats unread badges", () => {
  const base = {
    title: null,
    participants: [PERSONA.id],
    createdAt: 1000,
    updatedAt: 2000,
    lastText: "新消息",
    lastSeq: 4,
    active: false,
  };

  test("renders unread pill, sr-only label, and collapsed dot for unread chats not currently open", () => {
    const unreadId = "01900000-0000-7000-8000-000000000001";
    const cappedId = "01900000-0000-7000-8000-000000000002";
    const openId = "01900000-0000-7000-8000-000000000003";
    const readId = "01900000-0000-7000-8000-000000000004";

    const html = renderSidebar(
      [
        { ...base, id: unreadId, unread: 3 },
        { ...base, id: cappedId, unread: 120 },
        { ...base, id: openId, unread: 5 },
        { ...base, id: readId, unread: 0 },
      ],
      `/chats/${openId}`,
    );

    const unreadRow = itemMarkup(html, unreadId);
    expect(unreadRow).toContain("data-unread-count");
    expect(unreadRow).toContain(">3<");
    expect(unreadRow).toContain(", 3 unread");
    expect(unreadRow).toContain("data-unread-dot");

    const cappedRow = itemMarkup(html, cappedId);
    expect(cappedRow).toContain(">99+<");
    expect(cappedRow).toContain(", 120 unread");

    const openRow = itemMarkup(html, openId);
    expect(openRow).not.toContain("data-unread-count");
    expect(openRow).not.toContain("data-unread-dot");

    const readRow = itemMarkup(html, readId);
    expect(readRow).not.toContain("data-unread-count");
    expect(readRow).not.toContain("data-unread-dot");
  });
});
