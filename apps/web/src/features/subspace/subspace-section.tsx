import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { OrbitIcon } from "lucide-react";
import { ErrorAlert } from "@/components/error-alert";
import { SectionCardSkeleton } from "@/components/section-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { activeSubspaceServer, subspaceQuery } from "./queries";
import { RelayAccountCard } from "./relay-account-card";
import { ServersCard } from "./servers-card";
import { ShareCard } from "./share-card";

export function SubspaceSection() {
  const { t } = useLingui();
  const subspace = useQuery(subspaceQuery);
  if (subspace.isPending) return <SectionCardSkeleton rows={3} footer={false} />;
  if (subspace.isError) return <ErrorAlert error={subspace.error} />;

  const active = activeSubspaceServer(subspace.data);
  return (
    <div className="flex flex-col gap-6">
      {active !== null && (
        <Alert>
          <OrbitIcon />
          <AlertTitle>{t`Viewing a Remote Server`}</AlertTitle>
          <AlertDescription>
            {t`Paired servers, sharing, and your Relay account here are stored on this computer. Other Settings sections—and the Subspace Relay URL card below—configure ${ph({ name: active.name })}.`}
          </AlertDescription>
        </Alert>
      )}
      <ServersCard />
      <ShareCard />
      <RelayAccountCard />
    </div>
  );
}
