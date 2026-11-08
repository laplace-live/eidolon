// The capitalization of a short UI label's English source text: Title Case, with articles,
// coordinating conjunctions and prepositions lowercased whatever their length ("Hide until Next
// Update"), and a phrasal verb's particle capitalized ("Turn On").

const MINOR = new Set([
  "a",
  "an",
  "the",
  "and",
  "but",
  "or",
  "nor",
  "for",
  "about",
  "above",
  "across",
  "after",
  "against",
  "along",
  "among",
  "around",
  "as",
  "at",
  "before",
  "behind",
  "below",
  "beside",
  "between",
  "beyond",
  "by",
  "despite",
  "during",
  "except",
  "from",
  "in",
  "inside",
  "into",
  "like",
  "near",
  "of",
  "on",
  "onto",
  "outside",
  "over",
  "past",
  "per",
  "since",
  "than",
  "through",
  "to",
  "toward",
  "under",
  "until",
  "upon",
  "via",
  "with",
  "within",
  "without",
]);

/** Verbs whose particle is part of the verb, so it is capitalized: "Turn On", "Log In". */
const PHRASAL = new Set(["turn on", "log in", "sign in", "built in", "opt in", "take over"]);

/** Written in capitals in a label. */
const ACRONYMS: Readonly<Record<string, string>> = { id: "ID" };

/** Names written in lowercase whatever the case around them. */
const NAMES = new Set(["yt-dlp", "ffmpeg"]);

/** A word left as written: a placeholder, a tag, a file, a number, a name, or one with capitals inside. */
function verbatim(word: string): boolean {
  const core = word.replace(/^[("“]+|[.,;:!?…)"”]+$/g, "");
  return NAMES.has(core) || /[{}<>/_.@\d]/.test(core) || /\p{Lu}/u.test(core.slice(1));
}

function capitalized(word: string): string {
  const at = word.search(/\p{L}/u);
  if (at < 0) return word;
  const core = word.slice(at).replace(/[^\p{L}]+$/u, "");
  const acronym = ACRONYMS[core.toLowerCase()];
  if (acronym !== undefined) return word.slice(0, at) + acronym + word.slice(at + core.length);
  return word.slice(0, at) + word.charAt(at).toUpperCase() + word.slice(at + 1);
}

function lowered(word: string): string {
  const at = word.search(/\p{L}/u);
  return at < 0 ? word : word.slice(0, at) + word.charAt(at).toLowerCase() + word.slice(at + 1);
}

/** The bare word, for the minor-word and phrasal lookups. */
function bare(word: string): string {
  return word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "").toLowerCase();
}

/** `text` in Title Case: its first and last words always capitalized, minor words lowercased. */
export function titleCase(text: string): string {
  const words = text.split(" ");
  const last = words.findLastIndex((word) => /\p{L}/u.test(word));
  let first = true;
  let previous = "";
  return words
    .map((word, index) => {
      if (word === "" || !/\p{L}/u.test(word)) {
        // A bare "·" or "—" starts a new part, as a colon does.
        if (/^[·—:]$/.test(word)) first = true;
        return word;
      }
      const lower = bare(word);
      let out: string;
      if (verbatim(word)) out = word;
      else if (
        first ||
        index === last ||
        !MINOR.has(lower) ||
        PHRASAL.has(`${previous} ${lower}`)
      ) {
        out = capitalized(word);
      } else out = lowered(word);
      first = /[:—]$/.test(word);
      previous = lower;
      return out;
    })
    .join(" ");
}

/**
 * Whether a label's text keeps sentence case anyway: a full sentence or a question, or a status
 * still in progress ("{name} is thinking…").
 */
export function keepsSentenceCase(text: string): boolean {
  return /[.?!…]$/.test(text.trim()) || /[.?!] \S/.test(text);
}

/** A Lingui message the app shows where a label goes, by where it is written. */
export interface Label {
  readonly file: string;
  readonly line: number;
  /** Where it sits: `aria-label`, `<Button>`, `label:`, `ROLE_LABELS`… */
  readonly slot: string;
  /** Its English source text, `{name}` for each placeholder. */
  readonly text: string;
}

/** Elements whose text is a label: buttons, menu items, field and column labels, headings. */
const LABEL_ELEMENTS = new Set([
  "Button",
  "AlertDialogAction",
  "AlertDialogCancel",
  "DropdownMenuItem",
  "DropdownMenuRadioItem",
  "DropdownMenuLabel",
  "SelectItem",
  "ToggleGroupItem",
  "TabsTrigger",
  "CommandItem",
  "FieldLabel",
  "Label",
  "TableHead",
  "FieldLegend",
  "CardTitle",
  "DialogTitle",
  "AlertDialogTitle",
  "SheetTitle",
  "h1",
  "h2",
  "h3",
  "h4",
]);

/** Components whose `title` is a section's heading. */
const HEADED = new Set([
  "SectionCard",
  "SettingsCard",
  "PageHeader",
  "HomeSection",
  "StepCard",
  "ListRow",
  "LargeDialogContent",
  "PicturesCard",
  "ChoiceCard",
  "Priced",
]);

/** A const of labels by code. */
const LABEL_MAP = /_(LABELS|TITLES|NAMES)$/;

interface Node {
  readonly type: string;
  readonly loc: { readonly start: { readonly line: number } };
  readonly [key: string]: unknown;
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";

function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key.endsWith("Comments") || key === "extra") continue;
    if (Array.isArray(value)) out.push(...value.filter(isNode));
    else if (isNode(value)) out.push(value);
  }
  return out;
}

function elementName(node: Node): string {
  const name = (node.openingElement as Node | undefined)?.name as Node | undefined;
  if (name === undefined) return "";
  if (name.type === "JSXIdentifier") return name.name as string;
  if (name.type === "JSXMemberExpression") return (name.property as Node).name as string;
  return "";
}

/** A template literal's text, `{name}` for each `${ph({ name })}` or `${name}`. */
function templateText(node: Node): string {
  const quasis = node.quasis as Node[];
  const expressions = node.expressions as Node[];
  let text = "";
  quasis.forEach((quasi, i) => {
    text += ((quasi.value as { cooked: string }).cooked ?? "") as string;
    const expression = expressions[i];
    if (expression !== undefined) text += `{${placeholderName(expression)}}`;
  });
  return text;
}

function placeholderName(node: Node): string {
  if (node.type === "Identifier") return node.name as string;
  if (node.type === "CallExpression" && ((node.callee as Node).name as string) === "ph") {
    const object = (node.arguments as Node[])[0];
    const property = (object?.properties as Node[] | undefined)?.[0];
    const key = property?.key as Node | undefined;
    if (key) return (key.name as string) ?? (key.value as string);
  }
  if (node.type === "CallExpression" && ((node.callee as Node).name as string) === "plural") {
    return "plural";
  }
  return "0";
}

/** The text of a macro call: `` t`…` ``, `t({ message })`, `` msg`…` ``, `msg({ message })`. */
function macroText(node: Node, macros: ReadonlySet<string>): string | null {
  if (node.type === "TaggedTemplateExpression") {
    const tag = node.tag as Node;
    if (tag.type === "Identifier" && macros.has(tag.name as string)) {
      return templateText(node.quasi as Node);
    }
    return null;
  }
  if (node.type === "CallExpression") {
    const callee = node.callee as Node;
    if (callee.type !== "Identifier" || !macros.has(callee.name as string)) return null;
    const [first] = node.arguments as Node[];
    if (first?.type !== "ObjectExpression") return null;
    for (const property of first.properties as Node[]) {
      const key = property.key as Node | undefined;
      if (key?.type !== "Identifier" || key.name !== "message") continue;
      const value = property.value as Node;
      if (value.type === "StringLiteral") return value.value as string;
      if (value.type === "TemplateLiteral") return templateText(value);
    }
  }
  return null;
}

/** Where a macro's text is written, climbing through conditionals and wrappers. */
function slotOf(path: readonly Node[]): string | null {
  for (let i = path.length - 2; i >= 0; i--) {
    const node = path[i] as Node;
    const child = path[i + 1] as Node;
    switch (node.type) {
      case "ConditionalExpression":
        if (child === node.test) return null;
        continue;
      case "LogicalExpression":
      case "JSXExpressionContainer":
      case "ParenthesizedExpression":
      case "TSAsExpression":
      case "TSSatisfiesExpression":
        continue;
      case "JSXAttribute": {
        const name = (node.name as Node).name as string;
        // `action` and `…Label` take a button's text where a component draws the button itself.
        if (name === "aria-label" || name === "label" || name === "action") return name;
        if (/^[a-z]+Label$/.test(name)) return name;
        if (name === "heading") return "heading";
        if (name === "title") {
          const element = path[i - 1] as Node | undefined;
          const owner = element?.type === "JSXOpeningElement" ? (element.name as Node) : null;
          const ownerName = owner?.type === "JSXIdentifier" ? (owner.name as string) : "";
          return HEADED.has(ownerName) ? `<${ownerName} title>` : null;
        }
        return null;
      }
      case "JSXElement": {
        const name = elementName(node);
        if (LABEL_ELEMENTS.has(name)) return `<${name}>`;
        // A span inside a label is part of it, as a button's text hidden on a phone is.
        if (name === "span") continue;
        // A link drawn as a button or a menu item: <Button asChild><Link>…</Link></Button>.
        if (name === "Link" || name === "a") {
          const parent = path[i - 1]?.type === "JSXElement" ? path[i - 1] : undefined;
          const owner = parent ? elementName(parent) : "";
          if (LABEL_ELEMENTS.has(owner)) return `<${owner}>`;
        }
        return null;
      }
      case "ObjectProperty": {
        if (child !== node.value) return null;
        if (keyName(node) === "label") return "label:";
        return mapEntry(path, i);
      }
      default:
        return null;
    }
  }
  return null;
}

/** Keys of a label map's entry that hold prose about the label, not the label. */
const PROSE_KEYS = new Set(["body", "help", "hint", "note", "description"]);

function keyName(property: Node): string {
  const key = property.key as Node;
  return ((key.name as string | undefined) ?? (key.value as string | undefined)) || "";
}

/**
 * The label map an object property at `index` belongs to, at any depth, through `satisfies` and
 * `as const`; null when the map's name says it holds no labels, or a key on the way holds prose.
 */
function mapEntry(path: readonly Node[], index: number): string | null {
  let at = index;
  while (path[at]?.type === "ObjectProperty") {
    if (PROSE_KEYS.has(keyName(path[at] as Node))) return null;
    if (path[at - 1]?.type !== "ObjectExpression") return null;
    at -= 2;
  }
  while (path[at]?.type === "TSSatisfiesExpression" || path[at]?.type === "TSAsExpression") at--;
  const declarator = path[at];
  if (declarator?.type !== "VariableDeclarator") return null;
  const id = declarator.id as Node;
  const name = id.type === "Identifier" ? (id.name as string) : "";
  return LABEL_MAP.test(name) ? name : null;
}

/** Every Lingui message in `source` that sits where a label goes. */
export function labelsIn(
  file: string,
  source: string,
  parse: (source: string, tsx: boolean) => unknown,
): Label[] {
  const labels: Label[] = [];
  const macros = new Set(["t", "msg"]);
  const ast = parse(source, file.endsWith(".tsx")) as Node;
  const walk = (node: Node, path: Node[]) => {
    const here = [...path, node];
    const text = macroText(node, macros);
    if (text !== null) {
      const slot = slotOf(here);
      if (slot !== null) labels.push({ file, line: node.loc.start.line, slot, text });
    }
    for (const child of children(node)) walk(child, here);
  };
  walk(ast, []);
  return labels;
}
