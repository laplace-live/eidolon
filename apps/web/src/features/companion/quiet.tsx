// What the desktop companion's route shows while her page's chunk loads, and if it fails: nothing.
// Static on the route, so a chunk that fails to load still has a boundary, and the router loads only
// this of hers at start.
import { useEffect } from "react";
import { companion } from "@/lib/desktop";

export function Nothing() {
  return null;
}

/** Nothing, and main keeps her hidden: she was never drawn. */
export function CompanionError() {
  useEffect(() => {
    companion()?.drawn(null);
  }, []);
  return null;
}
