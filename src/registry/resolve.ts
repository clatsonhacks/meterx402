// HCS-14 resolution: UAID → what this registry knows about that agent.
//
// A `uaid:aid:` identity is a hash of six fields, so a resolver can do more
// than look the agent up: it can RECOMPUTE the id from the descriptor and say
// whether the agent really is who it claims to be. Nobody has to be trusted for
// that — not us, not the agent. A `uaid:did:` identity is a claim by whoever
// controls the DID, so we report it as unverifiable here instead of pretending.

import { createAid, parseUaid, skillsFor, toHederaCaip10, UAID_REGISTRY } from "../protocol/hcs14.ts";
import { PROTOCOL_VERSION, type ServiceDescriptor } from "../protocol/schemas.ts";

/** Recompute the canonical identity a descriptor should have. */
export function expectedUaid(d: ServiceDescriptor): string | null {
  try {
    const network = d.owner.network;
    return createAid({
      registry: UAID_REGISTRY,
      name: d.service_id,
      version: PROTOCOL_VERSION,
      protocol: "a2a",
      nativeId: network.startsWith("hedera:") ? toHederaCaip10(network, d.owner.account) : `${network}:${d.owner.account}`,
      skills: skillsFor(d.capabilities),
    }, { uid: d.service_id, proto: "a2a" });
  } catch { return null; }
}

export interface Resolution {
  uaid: string;
  resolved: boolean;
  method: "aid" | "did" | null;
  /** aid: recomputed and compared. did: not checkable from here. */
  verified: boolean | null;
  reason?: string;
  service_id?: string;
  agent?: {
    name: string; description?: string; endpoint: string;
    capabilities: string[]; skills: number[]; account: string; network: string;
    interfaces: string[]; pricing: ServiceDescriptor["pricing"];
  };
  links?: Record<string, string>;
}

export function resolveUaid(uaid: string, find: (u: string) => ServiceDescriptor | undefined): Resolution {
  let parsed;
  try { parsed = parseUaid(uaid); }
  catch { return { uaid, resolved: false, method: null, verified: null, reason: "not a UAID" }; }

  const d = find(uaid);
  if (!d) return { uaid, resolved: false, method: parsed.method, verified: null, reason: "no agent with that identity in this registry" };

  const expected = parsed.method === "aid" ? expectedUaid(d) : null;
  const verified = parsed.method === "aid"
    ? expected != null && parseUaid(expected).id === parsed.id
    : null;
  return {
    uaid,
    resolved: true,
    method: parsed.method,
    verified,
    reason: verified === false ? "the advertised identity does not match this agent's canonical fields" : undefined,
    service_id: d.service_id,
    agent: {
      name: d.name, description: d.description, endpoint: d.endpoint,
      capabilities: d.capabilities, skills: skillsFor(d.capabilities),
      account: d.owner.account, network: d.owner.network,
      interfaces: d.interfaces, pricing: d.pricing,
    },
    links: { descriptor: d.links.descriptor, ...(d.links.a2a_card ? { a2a_card: d.links.a2a_card } : {}) },
  };
}
