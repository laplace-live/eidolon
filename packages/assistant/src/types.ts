import type { TaskTool } from "@eidolon/engine";

/** What a task's file tools may touch. */
export interface PathGuard {
  /** The task's folder, absolute. */
  readonly folder: string;
  /**
   * `path`, resolved against the folder with ~ expanded, once `access` to it is allowed. Throws
   * PathRefused.
   */
  resolve(path: string, access: "read" | "write"): Promise<string>;
}

export class PathRefused extends Error {
  override name = "PathRefused";
  readonly path: string;
  readonly access: "read" | "write";
  /** "outside": no grant covers it; "denied": it is never a task's, whatever the grants. */
  readonly why: "outside" | "denied";

  constructor(path: string, access: "read" | "write", why: "outside" | "denied") {
    super(
      why === "outside"
        ? `${path} is outside the folders this task may ${access}`
        : `No task may ${access} ${path}`,
    );
    this.path = path;
    this.access = access;
    this.why = why;
  }
}

/** A task tool with what the worker's prompt says about it (pi's promptSnippet and promptGuidelines). */
export interface AssistantTool extends TaskTool {
  readonly snippet: string;
  readonly guidelines: readonly string[];
}
