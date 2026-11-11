import { CString, dlopen, FFIType } from "bun:ffi";

/** `name` as getenv reads it, which process.env doesn't change under Bun; null when unset. */
export function cEnv(name: string): string | null {
  const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
    getenv: { args: [FFIType.cstring], returns: FFIType.ptr },
  });
  try {
    const value = libc.symbols.getenv(Buffer.from(`${name}\0`));
    return value === null ? null : new CString(value).toString();
  } finally {
    libc.close();
  }
}
