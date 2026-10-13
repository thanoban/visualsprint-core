import { ManagedIdentityCredential, AzureCliCredential } from "@azure/identity";
import { AzureCommunicationEmail } from "./azure-email.js";
import { DisabledEmail } from "./authorities.js";
import type { EmailPort } from "../application/ports.js";
// Optional native factory; it never provisions a cloud resource or sends at startup.
export function configuredEmail(input: {
  endpoint?: string | undefined;
  sender?: string | undefined;
  webOrigin: string;
  identityClientId?: string | undefined;
  allowLocalAzureCli?: boolean | undefined;
}): EmailPort {
  if (!input.endpoint && !input.sender) return new DisabledEmail();
  if (!input.endpoint || !input.sender) throw new Error("INCOMPLETE_EMAIL_CONFIGURATION");
  const credential =
    process.env.NODE_ENV === "production"
      ? new ManagedIdentityCredential(
          input.identityClientId ? { clientId: input.identityClientId } : {},
        )
      : input.allowLocalAzureCli
        ? new AzureCliCredential()
        : new ManagedIdentityCredential(
            input.identityClientId ? { clientId: input.identityClientId } : {},
          );
  return new AzureCommunicationEmail(input.endpoint, input.sender, credential, input.webOrigin);
}
