import { networkInterfaces } from "node:os";

export type AddressKind = "tailscale" | "lan" | "public";

export interface ShareableAddress {
  readonly address: string;
  readonly interfaceName: string;
  readonly kind: AddressKind;
}

function isTailscaleIp(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  return octets.length === 4 && octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
}

function isRfc1918Ip(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4) return false;
  const [a, b] = [octets[0]!, octets[1]!];
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function classify(interfaceName: string, ip: string): AddressKind {
  if (interfaceName.toLowerCase().includes("tailscale") || isTailscaleIp(ip)) return "tailscale";
  if (isRfc1918Ip(ip)) return "lan";
  return "public";
}

const ORDER: Readonly<Record<AddressKind, number>> = { tailscale: 0, lan: 1, public: 2 };

/** Lists non-internal IPv4 addresses on this machine, preferring Tailscale, then LAN. */
export function listShareableAddresses(): ShareableAddress[] {
  const seen = new Set<string>();
  const out: ShareableAddress[] = [];
  for (const [interfaceName, entries] of Object.entries(networkInterfaces())) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (seen.has(entry.address)) continue;
      seen.add(entry.address);
      out.push({
        address: entry.address,
        interfaceName,
        kind: classify(interfaceName, entry.address),
      });
    }
  }
  return out.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.address.localeCompare(b.address));
}
