import { isChatId } from "@eidolon/chat";
import { useLingui } from "@lingui/react/macro";
import { MessagesSquareIcon } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { EmptyState } from "@/components/empty-state";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ChatListPanel, NewChatMenu } from "./chat-list";
import { ChatPlaceholder, ChatView } from "./chat-view";

/**
 * /chats lists them beside the open one; on a phone the list is the page until a chat opens, and
 * a sheet after.
 */
export function Component() {
  const { t } = useLingui();
  const { id } = useParams();
  const navigate = useNavigate();
  // The chat the sheet was opened over: opening another closes it.
  const [sheetOver, setSheetOver] = useState<string | null>(null);

  const onDeleted = (deleted: string) => {
    if (deleted === id) navigate("/chats", { replace: true });
  };

  return (
    <div className="flex flex-col">
      <h1 className="sr-only">{t`Chats`}</h1>
      <div className="flex h-[calc(100svh-var(--app-header-height)-5rem)] max-h-[56rem] min-h-[30rem] overflow-hidden rounded-xl border bg-card text-card-foreground">
        <aside className="hidden w-80 shrink-0 flex-col border-r md:flex">
          <ChatListPanel current={id} onDeleted={onDeleted} />
        </aside>
        <section className="flex min-w-0 flex-1 flex-col">
          {id === undefined ? (
            <>
              <ChatListPanel current={id} onDeleted={onDeleted} className="md:hidden" />
              <div className="hidden flex-1 items-center justify-center p-6 md:flex">
                <EmptyState
                  className="border-0"
                  icon={<MessagesSquareIcon />}
                  title={t`Pick a chat, or start a new one`}
                  description={t`Text a persona any time, no call needed. Each chat keeps its own history.`}
                  action={<NewChatMenu />}
                />
              </div>
            </>
          ) : isChatId(id) ? (
            <ChatView key={id} id={id} onShowList={() => setSheetOver(id)} onDeleted={onDeleted} />
          ) : (
            <ChatPlaceholder state="missing" onShowList={() => setSheetOver(id)} />
          )}
        </section>
      </div>
      <Sheet
        open={id !== undefined && sheetOver === id}
        onOpenChange={(open) => setSheetOver(open ? (id ?? null) : null)}
      >
        <SheetContent side="left" showCloseButton={false} className="w-80 gap-0 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>{t`Chats`}</SheetTitle>
            <SheetDescription>{t`Your chats, newest first.`}</SheetDescription>
          </SheetHeader>
          <ChatListPanel current={id} onDeleted={onDeleted} />
        </SheetContent>
      </Sheet>
    </div>
  );
}
