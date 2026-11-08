// CPython 3.13's `ipaddress.ip_address(host).is_global`, with its ValueError read as false,
// decides which candidates a relay can reach. The parser follows CPython's, which accepts zone ids
// `net.isIP` refuses (spaces, non-ASCII).

const IPV4_OCTET = /^[0-9]{1,3}$/;
const IPV6_HEXTET = /^[0-9A-Fa-f]{1,4}$/;

function parseIPv4(text: string): bigint | null {
  if (text.includes("/")) return null;
  const octets = text.split(".");
  if (octets.length !== 4) return null;
  let value = 0n;
  for (const octet of octets) {
    // Leading zeros are refused, as glibc's inet_pton does (bpo-36384).
    if (!IPV4_OCTET.test(octet) || (octet !== "0" && octet.startsWith("0"))) return null;
    const n = Number(octet);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseIPv6(text: string): bigint | null {
  if (text.includes("/")) return null;
  let address = text;
  const percent = text.indexOf("%");
  if (percent !== -1) {
    // A zone id may hold anything but another "%"; it never affects is_global.
    const scope = text.slice(percent + 1);
    if (scope === "" || scope.includes("%")) return null;
    address = text.slice(0, percent);
  }
  const parts = address.split(":");
  if (parts.length < 3) return null;
  const tail = parts[parts.length - 1] as string;
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    parts.splice(-1, 1, ((v4 >> 16n) & 0xffffn).toString(16), (v4 & 0xffffn).toString(16));
  }
  if (parts.length > 9) return null;

  let skip: number | null = null;
  for (let i = 1; i < parts.length - 1; i++) {
    if (parts[i] !== "") continue;
    if (skip !== null) return null;
    skip = i;
  }
  let before: number;
  let after: number;
  let skipped: number;
  if (skip !== null) {
    before = skip;
    after = parts.length - skip - 1;
    if (parts[0] === "") {
      before -= 1;
      if (before !== 0) return null;
    }
    if (parts[parts.length - 1] === "") {
      after -= 1;
      if (after !== 0) return null;
    }
    skipped = 8 - (before + after);
    if (skipped < 1) return null;
  } else {
    if (parts.length !== 8 || parts[0] === "" || parts[7] === "") return null;
    before = 8;
    after = 0;
    skipped = 0;
  }

  let value = 0n;
  const hextets = [
    ...parts.slice(0, before),
    ...Array<string>(skipped).fill("0"),
    ...parts.slice(parts.length - after),
  ];
  for (const hextet of hextets) {
    if (!IPV6_HEXTET.test(hextet)) return null;
    value = (value << 16n) | BigInt(`0x${hextet}`);
  }
  return value;
}

interface Network {
  readonly base: bigint;
  readonly shift: bigint;
}

function networks(bits: 32 | 128, cidrs: readonly string[]): readonly Network[] {
  const parse = bits === 32 ? parseIPv4 : parseIPv6;
  return cidrs.map((cidr) => {
    const [address = "", prefix = ""] = cidr.split("/");
    const shift = BigInt(bits - Number(prefix));
    return { base: (parse(address) as bigint) >> shift, shift };
  });
}

function inAny(value: bigint, nets: readonly Network[]): boolean {
  return nets.some((net) => value >> net.shift === net.base);
}

// CPython's _IPv4Constants and _IPv6Constants, after IANA's special-purpose registries. CPython
// revises them even in patch releases, and this copy does not follow.
const IPV4_SHARED = networks(32, ["100.64.0.0/10"]);
const IPV4_PRIVATE = networks(32, [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.0.170/31",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "240.0.0.0/4",
  "255.255.255.255/32",
]);
const IPV4_PRIVATE_EXCEPTIONS = networks(32, ["192.0.0.9/32", "192.0.0.10/32"]);
const IPV6_PRIVATE = networks(128, [
  "::1/128",
  "::/128",
  "::ffff:0:0/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
  "fc00::/7",
  "fe80::/10",
]);
const IPV6_PRIVATE_EXCEPTIONS = networks(128, [
  "2001:1::1/128",
  "2001:1::2/128",
  "2001:3::/32",
  "2001:4:112::/48",
  "2001:20::/28",
  "2001:30::/28",
]);

function ipv4IsGlobal(value: bigint): boolean {
  if (inAny(value, IPV4_SHARED)) return false;
  return !inAny(value, IPV4_PRIVATE) || inAny(value, IPV4_PRIVATE_EXCEPTIONS);
}

/**
 * Whether a TURN relay could plausibly send to `host`.
 *
 * False for anything not globally routable, and for mDNS names, which resolve only on the peer's
 * own LAN.
 */
export function relayCanReach(host: string): boolean {
  const v4 = parseIPv4(host);
  if (v4 !== null) return ipv4IsGlobal(v4);
  const v6 = parseIPv6(host);
  if (v6 === null) return false;
  // An IPv4-mapped address answers as the IPv4 address it carries.
  if (v6 >> 32n === 0xffffn) return ipv4IsGlobal(v6 & 0xffffffffn);
  return !inAny(v6, IPV6_PRIVATE) || inAny(v6, IPV6_PRIVATE_EXCEPTIONS);
}
