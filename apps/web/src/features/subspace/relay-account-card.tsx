import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import {
  CheckIcon,
  CloudIcon,
  CopyIcon,
  ExternalLinkIcon,
  LogInIcon,
  LogOutIcon,
} from "lucide-react";
import { SectionCard } from "@/components/section-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { subspaceQuery, useClipboardCopy, useLogoutRelayAuth, useStartRelayAuth } from "./queries";

export function RelayAccountCard() {
  const { t } = useLingui();
  const { data: state } = useQuery(subspaceQuery);
  const startAuth = useStartRelayAuth();
  const logoutAuth = useLogoutRelayAuth();
  const { copied: copiedCode, copy: copyUserCode } = useClipboardCopy(t`Verification code copied.`);

  const relayAuth = state?.relayAuth;
  if (!relayAuth) return null;

  const { user, deviceFlow } = relayAuth;
  const verifyUrl = deviceFlow.verificationUriComplete ?? deviceFlow.verificationUri;

  return (
    <SectionCard
      title={t`Subspace Relay Account`}
      description={t`Sign in with your LAPLACE ID in your browser to pair and reach your servers through the Subspace Relay without opening ports.`}
      note={t`Auth: ${ph({ auth: relayAuth.authUrl })} · Relay: ${ph({ relay: relayAuth.relayUrl })}`}
    >
      {deviceFlow.status === "error" && deviceFlow.error && (
        <Alert variant="destructive">
          <AlertTitle>{t`Relay sign-in failed.`}</AlertTitle>
          <AlertDescription>{deviceFlow.error}</AlertDescription>
        </Alert>
      )}

      {relayAuth.status === "signed-in" && user !== null ? (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border p-4">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <CloudIcon className="size-5" />
            </span>
            <div className="flex flex-col">
              <span className="font-medium text-sm">{user.name}</span>
              <span className="text-muted-foreground text-xs">{user.email}</span>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={logoutAuth.isPending}
            onClick={() => logoutAuth.mutate()}
          >
            {logoutAuth.isPending ? <Spinner /> : <LogOutIcon />}
            {t`Sign Out`}
          </Button>
        </div>
      ) : relayAuth.status === "pending" && deviceFlow.userCode !== null ? (
        <div className="flex flex-col gap-4 rounded-xl border bg-muted/30 p-4">
          <p className="text-sm">
            {t`Approve this computer in your browser by entering the verification code below:`}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <code className="rounded-lg border bg-background px-4 py-2 font-mono font-semibold text-xl tracking-widest">
              {deviceFlow.userCode}
            </code>
            <Button
              type="button"
              variant="outline"
              onClick={() => copyUserCode(deviceFlow.userCode!)}
            >
              {copiedCode ? <CheckIcon /> : <CopyIcon />}
              {copiedCode ? t`Copied` : t`Copy Code`}
            </Button>
            {verifyUrl !== null && (
              <Button asChild>
                <a href={verifyUrl} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon />
                  {t`Open Sign-In Page`}
                </a>
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              disabled={logoutAuth.isPending}
              onClick={() => logoutAuth.mutate()}
            >
              {t`Cancel`}
            </Button>
          </div>
          <p className="flex items-center gap-2 text-muted-foreground text-xs">
            <Spinner className="size-3.5" />
            {t`Waiting for browser sign-in…`}
          </p>
        </div>
      ) : (
        <div>
          <Button type="button" disabled={startAuth.isPending} onClick={() => startAuth.mutate()}>
            {startAuth.isPending ? <Spinner /> : <LogInIcon />}
            {t`Sign In with Browser`}
          </Button>
        </div>
      )}
    </SectionCard>
  );
}
