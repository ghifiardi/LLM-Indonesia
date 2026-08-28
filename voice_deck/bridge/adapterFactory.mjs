// Adapter selection is an explicit flag, and it defaults to the inert one.
//
// Defaulting to dry-run is the safety property: a bridge started by accident,
// by a stale script, or with a typo in the flag drives nothing. Choosing an
// adapter that moves a real presentation must be a deliberate act, and
// choosing to EXECUTE rather than rehearse is a second, separate act.
import { DryRunAdapter } from "./dryRunAdapter.mjs";
import { PowerPointAdapter } from "./powerpointAdapter.mjs";
import { implementsAdapterInterface } from "./adapterInterface.mjs";

export const ADAPTERS = Object.freeze(["dry-run", "powerpoint", "keynote"]);
export const DEFAULT_ADAPTER = "dry-run";

export function createAdapter(name = DEFAULT_ADAPTER, options = {}) {
  const choice = String(name || DEFAULT_ADAPTER).trim().toLowerCase();
  if (!ADAPTERS.includes(choice)) {
    return { ok: false, error: `unknown adapter "${name}" (expected: ${ADAPTERS.join(", ")})` };
  }
  if (choice === "keynote") {
    // Declared in the contract, not yet built (N2.5). Named explicitly so a
    // flag typo cannot silently fall back to something that DOES drive an app.
    return { ok: false, error: 'adapter "keynote" arrives in N2.5; use "dry-run" or "powerpoint"' };
  }

  const adapter = choice === "powerpoint"
    ? new PowerPointAdapter({ rehearsal: options.rehearsal !== false })
    : new DryRunAdapter({ slideCount: options.slideCount ?? 0 });

  if (!implementsAdapterInterface(adapter)) {
    return { ok: false, error: `adapter "${choice}" does not implement the adapter interface` };
  }
  return { ok: true, adapter };
}
