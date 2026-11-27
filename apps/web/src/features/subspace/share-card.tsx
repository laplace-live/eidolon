import type { MessageDescriptor } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon, CopyIcon, QrCodeIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { ListCard, ListRow } from "@/components/list";
import { QuietBadge } from "@/components/quiet-badge";
import { SectionCard } from "@/components/section-card";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { SubspaceShareableAddress } from "@/lib/api";
import { formatClockMinute, formatDateTime } from "@/lib/format";
import { useLang } from "@/locales/i18n";
import {
  subspaceQuery,
  useClipboardCopy,
  useCreateShareOffer,
  useRevokeSubspaceGrant,
  useUpdateShareSettings,
} from "./queries";

const ADDRESS_KIND_LABELS: Readonly<Record<SubspaceShareableAddress["kind"], MessageDescriptor>> = {
  tailscale: msg`Tailscale`,
  lan: msg`LAN`,
  public: msg`Public`,
};

const GRANT_MODE_LABELS: Readonly<Record<"direct" | "relay", MessageDescriptor>> = {
  direct: msg`Direct`,
  relay: msg`Relay`,
};

const CUSTOM_ADDRESS = "__custom__";

export function ShareCard() {
  const { t } = useLingui();
  const lang = useLang();
  const { data: state } = useQuery(subspaceQuery);

  const hostNameId = useId();
  const addrId = useId();
  const customAddrId = useId();
  const linkId = useId();

  const updateShare = useUpdateShareSettings();
  const createOffer = useCreateShareOffer();
  const revokeGrant = useRevokeSubspaceGrant();

  const [hostNameDraft, setHostNameDraft] = useState("");
  const [hostNameDirty, setHostNameDirty] = useState(false);
  const [customHost, setCustomHost] = useState("");
  const [customHostDirty, setCustomHostDirty] = useState(false);
  const [useCustomHost, setUseCustomHost] = useState(false);
  const lastDirectAddress = useRef<string | null | undefined>(undefined);
  const { copied: copiedLink, copy: copyLink } = useClipboardCopy(t`Pairing link copied.`);

  const share = state?.share;
  const relayAuth = state?.relayAuth;

  useEffect(() => {
    if (share && !hostNameDirty) setHostNameDraft(share.hostName);
  }, [share, hostNameDirty]);

  useEffect(() => {
    if (!share) return;
    const saved = share.directAddress;
    if (saved === lastDirectAddress.current) return;
    lastDirectAddress.current = saved;
    if (saved && !share.addresses.some((a) => a.address === saved)) {
      setUseCustomHost(true);
      if (!customHostDirty) setCustomHost(saved);
    } else if (saved !== null) {
      setUseCustomHost(false);
      if (!customHostDirty) setCustomHost("");
    }
  }, [share, customHostDirty]);

  if (!share || !relayAuth) return null;

  const selectedKnownAddress = !useCustomHost
    ? (share.directAddress ?? share.addresses[0]?.address ?? CUSTOM_ADDRESS)
    : CUSTOM_ADDRESS;
  const resolvedDirectHost =
    selectedKnownAddress === CUSTOM_ADDRESS
      ? customHost.trim() || share.addresses[0]?.address || ""
      : selectedKnownAddress;

  const busy = updateShare.isPending || createOffer.isPending || revokeGrant.isPending;
  const signedInToRelay = relayAuth.status === "signed-in";

  function saveHostName() {
    const trimmed = hostNameDraft.trim();
    if (!trimmed) return;
    updateShare.mutate(
      { hostName: trimmed },
      {
        onSuccess: () => {
          setHostNameDirty(false);
          toast.success(t`Host name updated.`);
        },
      },
    );
  }

  function saveDirectAddress(value: string, onSaved?: () => void) {
    updateShare.mutate(
      { directAddress: value },
      {
        onSuccess: (next) => {
          onSaved?.();
          if ((next?.share?.shareMode ?? share?.shareMode) !== "off") {
            createOffer.mutate({ mode: "auto", address: value });
          }
        },
      },
    );
  }

  function selectAddress(value: string) {
    if (value === CUSTOM_ADDRESS) {
      setUseCustomHost(true);
      return;
    }
    setUseCustomHost(false);
    setCustomHostDirty(false);
    saveDirectAddress(value);
  }

  function applyCustomHost() {
    const value = customHost.trim();
    if (!value) return;
    saveDirectAddress(value, () => setCustomHostDirty(false));
  }

  function generateOffer(rotate: boolean) {
    if (!resolvedDirectHost) return;
    createOffer.mutate({
      mode: "auto",
      address: resolvedDirectHost,
      rotate,
    });
  }

  const offer = share.activeOffer;
  const directStatus =
    share.shareMode === "off"
      ? t`Sharing is off. Generating a pairing link starts Direct sharing on your local network.`
      : share.listening && share.listeningPort !== null
        ? t`Listening directly on port ${ph({ port: String(share.listeningPort) })}.`
        : share.shareMode === "relay"
          ? t`Direct sharing is inactive in Relay-only mode.`
          : t`Starting direct listener…`;
  const relayStatus = !signedInToRelay
    ? t`Sign in to your Subspace Relay account below to add automatic Relay fallback.`
    : share.shareMode === "off"
      ? t`Automatic Subspace Relay fallback will activate as soon as you generate a link.`
      : share.relayConnected
        ? t`Subspace Relay fallback is active.`
        : share.relayError
          ? t`Relay fallback unavailable: ${ph({ error: share.relayError })}`
          : t`Connecting to Subspace Relay for fallback…`;

  return (
    <SectionCard
      title={t`Share This Computer`}
      description={t`Let another LAPLACE Eidolon app connect to this computer over your local network, Tailscale, or Subspace Relay.`}
    >
      <div className="flex flex-col gap-6">
        <Field>
          <FieldLabel htmlFor={hostNameId}>{t`Host Name`}</FieldLabel>
          <div className="flex max-w-md items-center gap-2">
            <Input
              id={hostNameId}
              value={hostNameDraft}
              onChange={(event) => {
                setHostNameDirty(true);
                setHostNameDraft(event.target.value);
              }}
              autoComplete="off"
            />
            <Button
              type="button"
              variant="outline"
              disabled={!hostNameDirty || !hostNameDraft.trim() || updateShare.isPending}
              onClick={saveHostName}
            >
              {t`Save`}
            </Button>
          </div>
          <FieldDescription>
            {t`Shown in the Subspace switcher on paired devices.`}
          </FieldDescription>
        </Field>

        <div className="flex flex-col gap-3">
          <Field>
            <FieldLabel htmlFor={addrId}>{t`Network Address`}</FieldLabel>
            <Select value={selectedKnownAddress} onValueChange={selectAddress} disabled={busy}>
              <SelectTrigger id={addrId} className="max-w-md">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {share.addresses.map((addr) => (
                  <SelectItem key={addr.address} value={addr.address}>
                    {`${addr.address} (${t(ADDRESS_KIND_LABELS[addr.kind])} · ${addr.interfaceName})`}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_ADDRESS}>{t`Custom Address`}</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>{`${directStatus} ${relayStatus}`}</FieldDescription>
          </Field>
          {selectedKnownAddress === CUSTOM_ADDRESS && (
            <Field>
              <FieldLabel htmlFor={customAddrId}>{t`Custom Host or IP`}</FieldLabel>
              <div className="flex max-w-md items-center gap-2">
                <Input
                  id={customAddrId}
                  value={customHost}
                  onChange={(event) => {
                    setCustomHostDirty(true);
                    setCustomHost(event.target.value);
                  }}
                  placeholder="100.x.y.z"
                  className="font-mono text-xs md:text-xs"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={!customHost.trim() || busy}
                  onClick={applyCustomHost}
                >
                  {t`Apply`}
                </Button>
              </div>
            </Field>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant={offer ? "outline" : "default"}
            disabled={busy || !resolvedDirectHost}
            onClick={() => generateOffer(Boolean(offer))}
          >
            {createOffer.isPending ? <Spinner /> : <QrCodeIcon />}
            {offer ? t`New Pairing Code` : t`Generate Pairing Code`}
          </Button>
          {share.shareMode !== "off" && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => updateShare.mutate({ shareMode: "off" })}
            >
              {t`Stop Sharing`}
            </Button>
          )}
        </div>

        {offer !== null && share.shareMode !== "off" && (
          <div className="flex flex-col gap-4 rounded-xl border bg-muted/30 p-4 sm:flex-row sm:items-start">
            <img
              src={`data:image/svg+xml;utf8,${encodeURIComponent(offer.qrSvg)}`}
              alt={t`Subspace Pairing QR Code`}
              className="size-44 shrink-0 rounded-lg border bg-white p-2"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <Field>
                <FieldLabel htmlFor={linkId}>{t`Pairing Link`}</FieldLabel>
                <div className="flex items-center gap-2">
                  <Input
                    id={linkId}
                    readOnly
                    value={offer.pairingUrl}
                    className="font-mono text-xs md:text-xs"
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void copyLink(offer.pairingUrl)}
                  >
                    {copiedLink ? <CheckIcon /> : <CopyIcon />}
                    {copiedLink ? t`Copied` : t`Copy Link`}
                  </Button>
                </div>
                <FieldDescription>
                  {t`Single-use link expires at ${ph({ time: formatClockMinute(offer.expiresAt, lang) })}. Generating a new code invalidates this one.`}
                </FieldDescription>
              </Field>
            </div>
          </div>
        )}

        {share.grants.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="font-medium text-sm">{t`Paired Devices`}</h3>
            <ListCard label={t`Paired Devices`}>
              {share.grants.map((grant) => (
                <ListRow
                  key={grant.id}
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="wrap-anywhere">{grant.clientName}</span>
                      <QuietBadge>{t(GRANT_MODE_LABELS[grant.mode])}</QuietBadge>
                    </span>
                  }
                  description={
                    grant.lastSeenAt !== null
                      ? t`Last connected ${ph({ time: formatDateTime(new Date(grant.lastSeenAt).toISOString(), lang) })}`
                      : t`Paired ${ph({ time: formatDateTime(new Date(grant.createdAt).toISOString(), lang) })}`
                  }
                  trailing={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={revokeGrant.isPending}
                      onClick={() => revokeGrant.mutate(grant.id)}
                    >
                      {t`Revoke`}
                    </Button>
                  }
                />
              ))}
            </ListCard>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
