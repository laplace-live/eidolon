// Every request that spends money reports what it used here; an app that keeps a ledger installs
// the sink, and without one a report costs nothing. A call, a job or an MCP request runs inside a
// scope that says which, so the code that spends needn't know who asked.
import { AsyncLocalStorage } from "node:async_hooks";
import { errorText, logger } from "@eidolon/config";
import { type Category, providerById, type RoleId, roleById } from "./catalog.ts";
import type { UsageHook } from "./http/chat.ts";
import { costOf, priceOf, type Units } from "./pricing.ts";

export type UsageSource = "call" | "mcp" | "job";

export interface UsageScope {
  readonly source: UsageSource;
  /** The call's or job's id. */
  readonly session?: string;
}

/** Where a recorded cost comes from: the provider's response, the catalog's price, or neither. */
export type CostSource = "reported" | "estimated" | "unpriced";

export interface UsageReport {
  readonly role: RoleId;
  readonly provider: string;
  readonly model: string;
  /**
   * The model asked for, where the provider answers with another id for it, such as a dated
   * snapshot: the catalog prices it under this one.
   */
  readonly requested?: string;
  readonly units: Units;
  /** What the provider says it billed; leave it out to estimate. */
  readonly costUsd?: number | null;
  /** The caller's own estimate, for a model the catalog doesn't price. */
  readonly estimatedUsd?: number | null;
}

export interface UsageRecord extends Omit<UsageReport, "estimatedUsd" | "requested"> {
  /** The role's. */
  readonly category: Category;
  /** ms since the epoch. */
  readonly at: number;
  readonly source: UsageSource | null;
  readonly session: string | null;
  readonly costUsd: number | null;
  readonly costSource: CostSource;
}

export type UsageSink = (record: UsageRecord) => void;

let sink: UsageSink | null = null;
const scopes = new AsyncLocalStorage<UsageScope>();

/** Sends every later report to `next`; null drops them. */
export function setUsageSink(next: UsageSink | null): void {
  sink = next;
}

/** Runs `fn` with its reports, and those of everything it starts, attributed to `scope`. */
export function withUsageScope<T>(scope: UsageScope, fn: () => T): T {
  return scopes.run(scope, fn);
}

/** The record a report becomes: the reported cost, else an estimate, else unpriced. */
export function usageRecord(report: UsageReport, at: number = Date.now()): UsageRecord {
  const scope = scopes.getStore();
  const { category } = roleById(report.role);
  let costUsd: number | null = null;
  let costSource: CostSource = "unpriced";
  if (typeof report.costUsd === "number" && Number.isFinite(report.costUsd)) {
    costUsd = report.costUsd;
    costSource = "reported";
  } else if (providerById(report.provider)?.free === true) {
    costUsd = 0;
    costSource = "estimated";
  } else {
    const price =
      priceOf(report.provider, category, report.model, at) ??
      (report.requested === undefined
        ? undefined
        : priceOf(report.provider, category, report.requested, at));
    const catalog = price === undefined ? null : costOf(price, report.units);
    const estimate = catalog ?? report.estimatedUsd ?? null;
    if (estimate !== null && Number.isFinite(estimate)) {
      costUsd = estimate;
      costSource = "estimated";
    }
  }
  const { estimatedUsd: _, requested: __, ...fields } = report;
  return {
    ...fields,
    category,
    at,
    source: scope?.source ?? null,
    session: scope?.session ?? null,
    costUsd,
    costSource,
  };
}

/** The hook a client reports each response through, as `role`'s use of `provider`. */
export function usageHook(role: RoleId, provider: string): UsageHook {
  return (units, model, costUsd, requested) =>
    reportUsage({ role, provider, model, requested, units, costUsd });
}

/** Records what a request used. Never throws: a ledger that fails must not fail the request. */
export function reportUsage(report: UsageReport): void {
  if (sink === null) return;
  try {
    sink(usageRecord(report));
  } catch (error) {
    logger.warning(`Usage not recorded: ${errorText(error)}`);
  }
}
