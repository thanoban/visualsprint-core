import { ManagedIdentityCredential } from "@azure/identity";
import { AzureRealtime, DisabledRealtime } from "./azure-realtime.js";
import type { RealtimePort } from "../application/ports.js";

export function configuredRealtime(input: {
  enabled: boolean;
  endpoint?: string | undefined;
  identityClientId?: string | undefined;
}): RealtimePort {
  if (!input.enabled) return new DisabledRealtime();
  if (!input.endpoint) throw new Error("INCOMPLETE_REALTIME_CONFIGURATION");
  return new AzureRealtime(
    input.endpoint,
    new ManagedIdentityCredential(
      input.identityClientId ? { clientId: input.identityClientId } : {},
    ),
  );
}
