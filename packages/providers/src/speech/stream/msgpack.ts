// The MessagePack Fish Audio's live socket speaks, without extension types
// (https://github.com/msgpack/msgpack/blob/master/spec.md). It packs as @msgpack/msgpack's defaults
// do, which is what pipedog's Fish service sent: the smallest int form for a safe integer, float64
// for any other number, and undefined as nil.

export type Packable =
  | null
  | undefined
  | boolean
  | number
  | string
  | Uint8Array
  | readonly Packable[]
  | { readonly [key: string]: Packable };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class Writer {
  #bytes = new Uint8Array(64);
  #view = new DataView(this.#bytes.buffer);
  #length = 0;

  #room(size: number): DataView {
    if (this.#length + size > this.#bytes.length) {
      const grown = new Uint8Array(Math.max(this.#bytes.length * 2, this.#length + size));
      grown.set(this.#bytes.subarray(0, this.#length));
      this.#bytes = grown;
      this.#view = new DataView(grown.buffer);
    }
    return this.#view;
  }

  u8(value: number): void {
    this.#room(1).setUint8(this.#length, value);
    this.#length += 1;
  }

  head(tag: number, size: 1 | 2 | 4 | 8, write: (view: DataView, at: number) => void): void {
    this.u8(tag);
    write(this.#room(size), this.#length);
    this.#length += size;
  }

  raw(bytes: Uint8Array): void {
    this.#room(bytes.length);
    this.#bytes.set(bytes, this.#length);
    this.#length += bytes.length;
  }

  done(): Uint8Array {
    return this.#bytes.slice(0, this.#length);
  }
}

function sized(
  out: Writer,
  length: number,
  fix: { readonly base: number; readonly max: number } | null,
  tags: readonly [number, number, number],
): void {
  if (fix !== null && length <= fix.max) out.u8(fix.base + length);
  else if (length < 0x100 && tags[0] !== 0) out.head(tags[0], 1, (v, at) => v.setUint8(at, length));
  else if (length < 0x10000) out.head(tags[1], 2, (v, at) => v.setUint16(at, length));
  else out.head(tags[2], 4, (v, at) => v.setUint32(at, length));
}

function packNumber(out: Writer, value: number): void {
  if (!Number.isSafeInteger(value)) {
    out.head(0xcb, 8, (v, at) => v.setFloat64(at, value));
  } else if (value >= 0) {
    if (value < 0x80) out.u8(value);
    else if (value < 0x100) out.head(0xcc, 1, (v, at) => v.setUint8(at, value));
    else if (value < 0x10000) out.head(0xcd, 2, (v, at) => v.setUint16(at, value));
    else if (value < 0x100000000) out.head(0xce, 4, (v, at) => v.setUint32(at, value));
    else out.head(0xcf, 8, (v, at) => v.setBigUint64(at, BigInt(value)));
  } else if (value >= -0x20) out.u8(0xe0 | (value + 0x20));
  else if (value >= -0x80) out.head(0xd0, 1, (v, at) => v.setInt8(at, value));
  else if (value >= -0x8000) out.head(0xd1, 2, (v, at) => v.setInt16(at, value));
  else if (value >= -0x80000000) out.head(0xd2, 4, (v, at) => v.setInt32(at, value));
  else out.head(0xd3, 8, (v, at) => v.setBigInt64(at, BigInt(value)));
}

function pack(out: Writer, value: Packable): void {
  if (value === null || value === undefined) out.u8(0xc0);
  else if (typeof value === "boolean") out.u8(value ? 0xc3 : 0xc2);
  else if (typeof value === "number") packNumber(out, value);
  else if (typeof value === "string") {
    const bytes = encoder.encode(value);
    sized(out, bytes.length, { base: 0xa0, max: 31 }, [0xd9, 0xda, 0xdb]);
    out.raw(bytes);
  } else if (value instanceof Uint8Array) {
    sized(out, value.length, null, [0xc4, 0xc5, 0xc6]);
    out.raw(value);
  } else if (Array.isArray(value)) {
    sized(out, value.length, { base: 0x90, max: 15 }, [0, 0xdc, 0xdd]);
    for (const item of value) pack(out, item);
  } else {
    const entries = Object.entries(value as { readonly [key: string]: Packable });
    sized(out, entries.length, { base: 0x80, max: 15 }, [0, 0xde, 0xdf]);
    for (const [key, item] of entries) {
      pack(out, key);
      pack(out, item);
    }
  }
}

export function packMsg(value: Packable): Uint8Array {
  const out = new Writer();
  pack(out, value);
  return out.done();
}

class Reader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #at = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  #take(size: number): number {
    const at = this.#at;
    if (at + size > this.#bytes.length) throw new Error("truncated MessagePack");
    this.#at += size;
    return at;
  }

  get atEnd(): boolean {
    return this.#at === this.#bytes.length;
  }

  u8 = () => this.#view.getUint8(this.#take(1));
  u16 = () => this.#view.getUint16(this.#take(2));
  u32 = () => this.#view.getUint32(this.#take(4));

  bytes(length: number): Uint8Array {
    const at = this.#take(length);
    return this.#bytes.slice(at, at + length);
  }

  value(): unknown {
    const tag = this.u8();
    if (tag < 0x80) return tag;
    if (tag < 0x90) return this.map(tag - 0x80);
    if (tag < 0xa0) return this.array(tag - 0x90);
    if (tag < 0xc0) return decoder.decode(this.bytes(tag - 0xa0));
    if (tag >= 0xe0) return tag - 0x100;
    const view = this.#view;
    switch (tag) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return this.bytes(this.u8());
      case 0xc5:
        return this.bytes(this.u16());
      case 0xc6:
        return this.bytes(this.u32());
      case 0xca:
        return view.getFloat32(this.#take(4));
      case 0xcb:
        return view.getFloat64(this.#take(8));
      case 0xcc:
        return this.u8();
      case 0xcd:
        return this.u16();
      case 0xce:
        return this.u32();
      case 0xcf:
        return Number(view.getBigUint64(this.#take(8)));
      case 0xd0:
        return view.getInt8(this.#take(1));
      case 0xd1:
        return view.getInt16(this.#take(2));
      case 0xd2:
        return view.getInt32(this.#take(4));
      case 0xd3:
        return Number(view.getBigInt64(this.#take(8)));
      case 0xd9:
        return decoder.decode(this.bytes(this.u8()));
      case 0xda:
        return decoder.decode(this.bytes(this.u16()));
      case 0xdb:
        return decoder.decode(this.bytes(this.u32()));
      case 0xdc:
        return this.array(this.u16());
      case 0xdd:
        return this.array(this.u32());
      case 0xde:
        return this.map(this.u16());
      case 0xdf:
        return this.map(this.u32());
    }
    throw new Error(`unsupported MessagePack type 0x${tag.toString(16)}`);
  }

  array(length: number): unknown[] {
    return Array.from({ length }, () => this.value());
  }

  map(size: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < size; i++) {
      const key = this.value();
      out[String(key)] = this.value();
    }
    return out;
  }
}

/** One MessagePack value; throws on extension types, bad input and trailing bytes. */
export function unpackMsg(bytes: Uint8Array): unknown {
  const reader = new Reader(bytes);
  const value = reader.value();
  if (!reader.atEnd) throw new Error("trailing bytes after MessagePack value");
  return value;
}
