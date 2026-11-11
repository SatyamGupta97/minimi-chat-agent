import { z } from "zod";
import type { Provider } from "./providers/types.ts";
import type { ProfileOp, Store } from "./store.ts";

/**
 * Keep the user profile current instead of piling facts up.
 *
 * New statements the user made about themselves are reconciled against the
 * existing facts in one small structured call: add (new information), update
 * (replaces a fact: "moved to Pune" supersedes "lives in Delhi"), delete (the
 * user retracted it: "forget my budget"), or nothing (already known). This is
 * the same idea as Mem0's ADD/UPDATE/DELETE/NOOP memory updates.
 *
 * If the call fails, the fallback adds only statements that aren't already in
 * the profile verbatim. Nothing is lost; at worst a stale fact lingers.
 */

const Decision = z.object({
  ops: z.array(
    z.object({
      op: z.enum(["add", "update", "delete", "none"]),
      id: z.string().nullable().describe("For update/delete: the id of the existing fact; otherwise null"),
      text: z.string().nullable().describe("For add/update: the fact as one self-contained sentence about the user; otherwise null"),
    }),
  ),
});

export async function reconcileProfile(provider: Provider, store: Store, statements: string[], at: string, sourceTurnId?: string): Promise<number> {
  const fresh = statements.map((s) => s.trim()).filter(Boolean);
  if (!fresh.length) return 0;
  const existing = store.profileFacts();
  // Nothing to reconcile against: just add.
  if (!existing.length) return store.applyProfileOps(fresh.map((text) => ({ op: "add", text })), at, sourceTurnId);

  let ops: ProfileOp[];
  try {
    const decision = await provider.json(
      `You maintain a short profile of facts about a user. Reconcile the NEW statements (from the user's latest message) with the EXISTING facts.
For each new statement choose exactly one:
- "update": it changes or corrects an existing fact (e.g. new city, new job, new team size): give that fact's id and the new full sentence.
- "delete": the user retracts an existing fact or asks you to forget it: give that fact's id.
- "add": it's new information not covered by any existing fact: give the sentence.
- "none": it's already captured by an existing fact.
Never merge unrelated facts. Write facts as self-contained sentences about "the user".

<existing_facts>
${existing.map((f) => `${f.id}: ${f.text}`).join("\n")}
</existing_facts>

<new_statements>
${fresh.map((s) => `- ${s}`).join("\n")}
</new_statements>`,
      Decision,
    );
    ops = decision.ops.flatMap((o): ProfileOp[] => {
      if (o.op === "add" && o.text) return [{ op: "add", text: o.text }];
      if (o.op === "update" && o.id && o.text) return [{ op: "update", id: o.id, text: o.text }];
      if (o.op === "delete" && o.id) return [{ op: "delete", id: o.id }];
      return [];
    });
  } catch (e) {
    console.warn("[profile] reconcile failed; adding only new statements:", (e as Error).message);
    ops = fresh.map((text) => ({ op: "add", text }));
  }
  return store.applyProfileOps(ops, at, sourceTurnId);
}
