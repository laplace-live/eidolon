// Lingui's macros compile at build time, and `bun test` has no transform, so they throw if run. A
// test of a module that uses them stubs `@lingui/core/macro` with this before importing it; the
// stubs give the English source text, placeholders filled.
type Values = Readonly<Record<string, unknown>>;
interface Descriptor {
  readonly id?: string;
  readonly message?: string;
  readonly context?: string;
  readonly values?: Values;
}

const isTemplate = (value: unknown): value is TemplateStringsArray =>
  Array.isArray(value) && "raw" in value;

function joined(strings: TemplateStringsArray, values: readonly unknown[]): string {
  return strings.reduce(
    (out, chunk, i) => out + chunk + (i < values.length ? String(values[i]) : ""),
    "",
  );
}

function filled(message: string, values: Values | undefined): string {
  return message.replace(/\{(\w+)\}/g, (whole, name: string) =>
    values !== undefined && name in values ? String(values[name]) : whole,
  );
}

export function linguiMacro() {
  return {
    t: (first: TemplateStringsArray | Descriptor, ...values: unknown[]): string =>
      isTemplate(first) ? joined(first, values) : filled(first.message ?? "", first.values),
    msg: (first: TemplateStringsArray | Descriptor, ...values: unknown[]): Descriptor => {
      const message = isTemplate(first) ? joined(first, values) : (first.message ?? "");
      return isTemplate(first) ? { id: message, message } : { ...first, id: message };
    },
    ph: (placeholder: Values): unknown => Object.values(placeholder)[0],
    plural: (value: unknown, forms: { readonly one?: string; readonly other: string }): string => {
      const count = Number(value);
      const form = count === 1 && forms.one !== undefined ? forms.one : forms.other;
      return form.replaceAll("#", new Intl.NumberFormat("en").format(count));
    },
  };
}
