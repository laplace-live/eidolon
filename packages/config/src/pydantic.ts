import { pyRepr, pyTypeName } from "./py.ts";

/** One entry of pydantic's `ValidationError.errors()`. */
export interface PydanticLineError {
  /** Empty for an error on the model's input as a whole, which prints no location line. */
  readonly loc: readonly (string | number)[];
  readonly type: string;
  readonly msg: string;
  readonly input: unknown;
}

function utf8Length(ch: string): number {
  const code = ch.codePointAt(0) as number;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  return code < 0x10000 ? 3 : 4;
}

/**
 * pydantic-core's `input_value`: a repr over 50 UTF-8 bytes keeps its first 25 and last 24 bytes,
 * cut back to whole characters, around "...".
 */
function displayInput(value: unknown): string {
  const repr = pyRepr(value);
  const chars = [...repr];
  if (chars.reduce((n, ch) => n + utf8Length(ch), 0) <= 50) return repr;
  let head = "";
  for (let i = 0, bytes = 0; i < chars.length; i++) {
    bytes += utf8Length(chars[i] as string);
    if (bytes > 25) break;
    head += chars[i];
  }
  let tail = "";
  for (let i = chars.length - 1, bytes = 0; i >= 0; i--) {
    bytes += utf8Length(chars[i] as string);
    if (bytes > 24) break;
    tail = chars[i] + tail;
  }
  return `${head}...${tail}`;
}

/** `str(ValidationError)` for a model named `title`. The URL names Python's pydantic version. */
export function validationErrorText(title: string, errors: readonly PydanticLineError[]): string {
  const lines = [`${errors.length} validation error${errors.length === 1 ? "" : "s"} for ${title}`];
  for (const e of errors) {
    if (e.loc.length > 0) lines.push(e.loc.join("."));
    lines.push(
      `  ${e.msg} [type=${e.type}, input_value=${displayInput(e.input)}, ` +
        `input_type=${pyTypeName(e.input)}]`,
      `    For further information visit https://errors.pydantic.dev/2.13/v/${e.type}`,
    );
  }
  return lines.join("\n");
}
