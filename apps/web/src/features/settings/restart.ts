import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { call, errorKey } from "@/lib/api";
import { useT } from "@/lib/i18n";

const WAIT_MS = 60_000;
const POLL_MS = 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether the server came back from a restart. The old one keeps answering until its jobs stop,
 * so only a status that no longer asks for a restart is the new process.
 */
async function cameBack(): Promise<boolean> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    try {
      const status = await call("GET /api/local/status");
      if (!status.restartRequired && !status.mcpRestartRequired) return true;
    } catch {
      // Down between the two processes.
    }
  }
  return false;
}

/** POST restart, which stops running jobs, then waits for the supervisor's new server. */
export function useRestart() {
  const t = useT();
  const queryClient = useQueryClient();
  const [restarting, setRestarting] = useState(false);

  async function restart() {
    setRestarting(true);
    try {
      await call("POST /api/local/restart");
      if (await cameBack()) {
        await queryClient.invalidateQueries();
        toast.success(t("settings.restart.done"));
      } else {
        toast.error(t("settings.restart.timeout"));
      }
    } catch (error) {
      toast.error(t(errorKey(error)));
    } finally {
      setRestarting(false);
    }
  }

  return { restart, restarting };
}
