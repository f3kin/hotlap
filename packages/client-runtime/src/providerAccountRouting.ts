/**
 * Why Auto account switching cannot be chosen right now. Web and mobile decide
 * this from their own provider state, but share the sentence they show so a
 * user reading one surface is told the same thing on the other.
 */
export type ProviderRoutingAutoBlocker =
  | "not-configured"
  | "threshold"
  | "account-unavailable"
  | "account-not-pooled"
  | "pool-too-small";

const PROVIDER_ROUTING_AUTO_BLOCKER_MESSAGES: Record<ProviderRoutingAutoBlocker, string> = {
  "not-configured": "Turn on automatic account switching in this project's settings.",
  threshold: "Set a switch-at percentage for this project.",
  "account-unavailable": "This account is not available for switching.",
  "account-not-pooled": "Add this account to the project's switching pool.",
  "pool-too-small": "Add a second account for this provider to the pool.",
};

export function providerRoutingAutoBlockerMessage(
  blocker: ProviderRoutingAutoBlocker | null,
): string | null {
  return blocker === null ? null : PROVIDER_ROUTING_AUTO_BLOCKER_MESSAGES[blocker];
}
