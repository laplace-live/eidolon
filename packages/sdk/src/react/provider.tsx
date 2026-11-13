import { createContext, type ReactNode, useContext } from "react";
import type { EidolonClient } from "../call/client.ts";

const EidolonClientContext = createContext<EidolonClient | null>(null);

export interface EidolonClientProviderProps {
  readonly client: EidolonClient;
  readonly children: ReactNode;
}

export function EidolonClientProvider({ client, children }: EidolonClientProviderProps) {
  return <EidolonClientContext.Provider value={client}>{children}</EidolonClientContext.Provider>;
}

export function useOptionalEidolonClient(): EidolonClient | null {
  return useContext(EidolonClientContext);
}

/** Reads the nearest `EidolonClientProvider`'s client, throwing if rendered outside one. */
export function useEidolonClient(): EidolonClient {
  const client = useContext(EidolonClientContext);
  if (client === null) {
    throw new Error("useEidolonClient must be used within an EidolonClientProvider");
  }
  return client;
}
