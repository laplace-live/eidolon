// The commands the owner allowed for good from tasks' cards, each in one folder: Always in This
// Folder adds one, Settings takes one back. They are approvals rather than settings, kept in the
// data home's tasks/allowed-commands.json, which this process alone writes.
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { errorText, isPlainObject, logger } from "@eidolon/config";
import type { AllowedCommand } from "../api.ts";

export const ALLOWED_COMMANDS_FILE = "allowed-commands.json";

function isAllowed(value: unknown): value is AllowedCommand {
  return (
    isPlainObject(value) &&
    typeof value.id === "string" &&
    typeof value.folder === "string" &&
    typeof value.command === "string" &&
    Number.isFinite(value.addedAt) &&
    typeof value.task === "string"
  );
}

const newestFirst = (a: AllowedCommand, b: AllowedCommand): number =>
  b.addedAt - a.addedAt || b.id.localeCompare(a.id);

export class AllowedCommands {
  readonly #path: string;
  readonly #now: () => number;
  /** What the file holds, once read: none when it is missing or damaged. */
  #commands: readonly AllowedCommand[] | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string, now: () => number = Date.now) {
    this.#path = path;
    this.#now = now;
  }

  /** Newest first. */
  list(): Promise<AllowedCommand[]> {
    return this.#serial(async () => [...(await this.#read())].sort(newestFirst));
  }

  /** Whether `command`, exactly, runs unasked in `folder`, the folder's realpath. */
  allows(folder: string, command: string): Promise<boolean> {
    return this.#serial(async () => (await this.#read()).some(matching(folder, command)));
  }

  /** Allows `command` in `folder` for good, for task `task`'s card, unless it is already. */
  add(folder: string, command: string, task: string): Promise<void> {
    return this.#serial(async () => {
      const commands = await this.#read();
      if (commands.some(matching(folder, command))) return;
      const id = Bun.randomUUIDv7();
      await this.#write([...commands, { id, folder, command, addedAt: this.#now(), task }]);
    });
  }

  /** Takes command `id` back; false when none has that id. */
  remove(id: string): Promise<boolean> {
    return this.#serial(async () => {
      const commands = await this.#read();
      const rest = commands.filter((each) => each.id !== id);
      if (rest.length === commands.length) return false;
      await this.#write(rest);
      return true;
    });
  }

  /** Each read and write after the one before, so two answers can't drop each other's grant. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #read(): Promise<readonly AllowedCommand[]> {
    if (this.#commands !== null) return this.#commands;
    let commands: AllowedCommand[] = [];
    try {
      const value: unknown = JSON.parse(await readFile(this.#path, "utf8"));
      if (!isPlainObject(value) || value.v !== 1 || !Array.isArray(value.commands)) {
        throw new Error("it isn't a version 1 list of commands");
      }
      commands = value.commands.filter(isAllowed);
    } catch (error) {
      // Read as none, every command asks again: the safe side.
      if ((error as { code?: unknown }).code !== "ENOENT") {
        logger.warning(`Ignoring ${this.#path}: ${errorText(error)}`);
      }
    }
    this.#commands = commands;
    return commands;
  }

  /** Replaces the file whole, 0600: a reader sees the old list or the new one. */
  async #write(commands: readonly AllowedCommand[]): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temp = `${this.#path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ v: 1, commands }, null, 2)}\n`);
        await handle.datasync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.#path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    this.#commands = commands;
  }
}

function matching(folder: string, command: string): (each: AllowedCommand) => boolean {
  // Exactly: a realpath already has a case-insensitive volume's own case, and on a case-sensitive
  // one App and app are two folders.
  return (each) => each.command === command && each.folder === folder;
}
