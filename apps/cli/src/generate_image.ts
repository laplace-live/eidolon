// laplace-generate-image: a text prompt plus optional reference images through the same OpenRouter
// call and built-in selfie prompt the bot's take_selfie tool uses, so what you probe here is what a
// viewer gets.
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  expandUser,
  pyFixed,
  pyPath,
  pyPathName,
  pyPathStem,
  pyPathSuffix,
  pyPathWithName,
  pyRepr,
  pyStrip,
  pyTruthy,
  sortedPy,
} from "@eidolon/config";
import {
  ASPECT_RATIOS,
  buildSelfiePrompt,
  DEFAULT_IMAGE_MODEL,
  friendSources,
  type GeneratedImage,
  type Generation,
  generate,
  ImageGenError,
  imageSuffix,
  loadReference,
  MAX_IMAGES,
  MAX_REFERENCES,
  type PersonaClock,
  QUALITIES,
  referenceSources,
} from "@eidolon/imagegen";
import { hasKey, missingKey, trySelect } from "@eidolon/providers";
import { ArgparseExit, INT, type ParserSpec, parseArgs } from "./argparse.ts";
import { type CliIo, printer, reportExit, resolveIo } from "./io.ts";
import { textwrapIndent } from "./py.ts";

export const DEFAULT_OUT_PATH = "data/generated/image.png";

const USAGE = `usage: laplace-generate-image [-h] [-i PATH_OR_URL] [-o OUT] [-n N]
                              [--model MODEL]
                              [--aspect-ratio {auto,1:1,3:2,2:3,4:3,3:4,16:9,9:16,21:9}]
                              [--quality {auto,low,medium,high,xhigh,max}]
                              [--friend NAME]
                              [prompt]
`;

// argparse refills the module docstring into one paragraph, Usage block and all.
const HELP = `${USAGE}
Generate an image from a text prompt plus optional reference images. The bot's
selfie tool and this script share one path — \`\`image_generation\`\` owns the
OpenRouter call and the built-in prompt, so what you probe here is what a
viewer gets. Usage: uv run laplace-generate-image "put her in a red scarf,
keep the pose" -i ref.png -o out.png uv run laplace-generate-image -i ref.png
# falls back to the built-in prompt uv run laplace-generate-image --friend
七海Nana7mi # the group-selfie variant

positional arguments:
  prompt                What to generate, or how to edit the references
                        (default: the built-in prompt)

options:
  -h, --help            show this help message and exit
  -i, --image PATH_OR_URL
                        Reference image, local path or URL; repeat for up to
                        16. Defaults to the outfit the bot would use at this
                        hour; naming one here bypasses that choice.
  -o, --out OUT         Where to write it; the suffix follows the response
                        (default: data/generated/image.png)
  -n N                  How many to generate, 1-10 (default: 1)
  --model MODEL         OpenRouter model slug (default: openai/gpt-
                        image-2.5-flare)
  --aspect-ratio {auto,1:1,3:2,2:3,4:3,3:4,16:9,9:16,21:9}
  --quality {auto,low,medium,high,xhigh,max}
  --friend NAME         Put a friend from selfie-references/friends in the
                        shot; repeat for more
`;

/** The parser, whose `--friend` choices are the friend images that exist right now. */
export function generateImageParser(knownFriends: Iterable<string>): ParserSpec {
  const friends = sortedPy(knownFriends);
  return {
    prog: "laplace-generate-image",
    usage: USAGE,
    help: HELP,
    actions: [
      { dest: "prompt", flags: [], kind: "store", nargs: "?" },
      { dest: "image", flags: ["-i", "--image"], kind: "append" },
      { dest: "out", flags: ["-o", "--out"], kind: "store", default: DEFAULT_OUT_PATH },
      { dest: "n", flags: ["-n"], kind: "store", type: INT, default: 1 },
      { dest: "model", flags: ["--model"], kind: "store", default: DEFAULT_IMAGE_MODEL },
      {
        dest: "aspect_ratio",
        flags: ["--aspect-ratio"],
        kind: "store",
        choices: ASPECT_RATIOS,
        default: "auto",
      },
      { dest: "quality", flags: ["--quality"], kind: "store", choices: QUALITIES, default: "auto" },
      {
        dest: "friend",
        flags: ["--friend"],
        kind: "append",
        choices: friends.length > 0 ? friends : null,
      },
    ],
  };
}

export interface GenerateImageArgs {
  readonly prompt: string | null;
  readonly image: readonly string[] | null;
  readonly out: string;
  readonly n: number;
  readonly model: string;
  readonly aspectRatio: string;
  readonly quality: string;
  readonly friend: readonly string[] | null;
}

/** Throws ArgparseExit for -h and usage errors. */
export function parseGenerateImageArgs(
  argv: readonly string[],
  knownFriends: Iterable<string>,
): GenerateImageArgs {
  const ns = parseArgs(generateImageParser(knownFriends), argv);
  return {
    prompt: ns.prompt as string | null,
    image: ns.image as string[] | null,
    out: ns.out as string,
    n: ns.n as number,
    model: ns.model as string,
    aspectRatio: ns.aspect_ratio as string,
    quality: ns.quality as string,
    friend: ns.friend as string[] | null,
  };
}

/** `base` renamed to the suffix the API returned, numbered when more than one came back. */
export function outPath(base: string, index: number, count: number, image: GeneratedImage): string {
  let stem = pyPathSuffix(base) ? pyPathStem(base) : pyPathName(base);
  if (count > 1) stem = `${stem}-${index + 1}`;
  return pyPathWithName(base, stem + imageSuffix(image.mediaType));
}

export interface GenerateImageDeps extends Partial<CliIo> {
  readonly fetch?: typeof fetch;
  /** The persona clock, read where Python reads it; the wall clock in PERSONA_TIMEZONE by default. */
  readonly clock?: () => PersonaClock;
  /** The selfie-references directory; the bundled one by default. */
  readonly referencesRoot?: string;
}

/** The `laplace-generate-image` command; resolves to its exit code. */
export async function generateImageMain(
  argv: readonly string[],
  deps: GenerateImageDeps = {},
): Promise<number> {
  const io = resolveIo(deps);
  const print = printer(io.stdout);
  const root = deps.referencesRoot;
  const knownFriends = friendSources(root === undefined ? {} : { root });
  let args: GenerateImageArgs;
  try {
    args = parseGenerateImageArgs(argv, knownFriends.keys());
  } catch (error) {
    if (error instanceof ArgparseExit) return reportExit(io, error);
    throw error;
  }

  // The selfie role's account, as the bot's take_selfie tool uses it.
  const selfie = trySelect("selfie");
  if (selfie === null || !hasKey(selfie)) {
    io.stderr(
      selfie !== null && selfie.keyName === null
        ? `${missingKey(selfie).message}\n`
        : `${selfie?.keyName ?? "OPENROUTER_API_KEY"} is unset.\n`,
    );
    return 1;
  }
  const apiKey = selfie.apiKey as string;

  const friends = args.friend ?? [];
  const missing = friends.filter((name) => !knownFriends.has(name));
  if (missing.length > 0) {
    io.stderr(
      `unknown friend(s) ${pyRepr(missing)}; known: ${pyRepr(sortedPy(knownFriends.keys()))}\n`,
    );
    return 1;
  }

  const outfit = () =>
    referenceSources({
      ...(root === undefined ? {} : { root }),
      ...(deps.clock ? { clock: deps.clock() } : {}),
    });
  const sources = [
    ...(args.image && args.image.length > 0 ? args.image : outfit()),
    ...friends.map((name) => knownFriends.get(name) as string),
  ];
  if (sources.length > MAX_REFERENCES) {
    io.stderr(`${sources.length} references given; the cap is ${MAX_REFERENCES}.\n`);
    return 1;
  }
  if (!(args.n >= 1 && args.n <= MAX_IMAGES)) {
    io.stderr(`-n must be between 1 and ${MAX_IMAGES}.\n`);
    return 1;
  }

  const prompt = args.prompt || buildSelfiePrompt(friends, deps.clock?.());
  print(`${args.model}: ${args.n} image(s) from ${sources.length} reference(s)`);
  if (!args.prompt) {
    print(`No prompt given; using the built-in one:\n${textwrapIndent(pyStrip(prompt), "  ")}`);
  }

  let result: Generation;
  try {
    const references = sources.map((source) => loadReference(source));
    result = await generate({
      apiKey,
      url: `${(selfie.baseUrl as string).replace(/\/+$/, "")}/images`,
      prompt,
      references,
      model: args.model,
      n: args.n,
      aspectRatio: args.aspectRatio,
      quality: args.quality,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
  } catch (error) {
    if (!(error instanceof ImageGenError)) throw error;
    io.stderr(`${error.message}\n`);
    return 1;
  }

  const base = pyPath(expandUser(args.out));
  mkdirSync(dirname(base), { recursive: true });
  result.images.forEach((image, index) => {
    const path = outPath(base, index, result.images.length, image);
    writeFileSync(path, image.data);
    print(`Wrote ${path} (${pyFixed(statSync(path).size / 1024, 0)} KB)`);
  });
  if (pyTruthy(result.costUsd)) print(`Cost: $${pyFixed(result.costUsd as number, 4)}`);
  return 0;
}
