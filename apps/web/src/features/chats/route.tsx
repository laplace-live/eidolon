import { isChatId } from "@eidolon/chat";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { MessagesSquareIcon, PlusIcon } from "lucide-react";
import { useParams } from "wouter";
import { EmptyState } from "@/components/empty-state";
import { MobileBar } from "@/components/mobile-bar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { NewChatMenu } from "./chat-list";
import { ChatPlaceholder, ChatView } from "./chat-view";
import { chatsQuery } from "./queries";

/** No chat open: start one, or pick one from the sidebar. */
function NoChat() {
  const { t } = useLingui();
  const none = useQuery(chatsQuery).data?.length === 0;
  return (
    <>
      <MobileBar />
      <div className="flex flex-1 items-center justify-center p-6">
        <EmptyState
          className="border-0"
          icon={<MessagesSquareIcon />}
          title={none ? t`No chats yet` : t`Pick a chat, or start a new one`}
          description={
            none
              ? t`Start one with any persona, or with several at once. Each chat keeps its own history.`
              : t`Text one persona or several at once, no call needed. Each chat keeps its own history.`
          }
          action={
            <NewChatMenu>
              {({ pending, disabled }) => (
                <Button disabled={disabled}>
                  {pending ? <Spinner /> : <PlusIcon />}
                  {t`New Chat`}
                </Button>
              )}
            </NewChatMenu>
          }
        />
      </div>
    </>
  );
}

/** /chats/:id opens a chat, which fills the frame; the sidebar lists them. */
export function Component() {
  const { t } = useLingui();
  const { id } = useParams();
  return (
    <>
      <h1 className="sr-only">{t`Chats`}</h1>
      {id === undefined ? (
        <NoChat />
      ) : isChatId(id) ? (
        <ChatView key={id} id={id} />
      ) : (
        <ChatPlaceholder state="missing" />
      )}
    </>
  );
}
