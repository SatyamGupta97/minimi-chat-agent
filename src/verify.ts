/**
 * The app-level verification guard.
 *
 * Prompt rules alone don't stop a model from asserting "no change" for items it
 * never searched (observed live: 5 recalled CRMs, 2 searched, 5 "verified").
 * But the app knows both sides: which items a re-check question is about (the
 * entities of the recalled exchanges) and which searches actually ran. So:
 *   1. the model gets an explicit checklist of items to verify, and
 *   2. after the answer, any checklist item no search mentioned is flagged to
 *      the user as not verified, whatever the answer claims.
 */

/** Is the user asking whether something from the past still holds? */
export function isRecheckQuestion(message: string): boolean {
  return /\b(chang\w*|still (correct|true|valid|accurate|right|the same)|since then|since (monday|tuesday|wednesday|thursday|friday|saturday|sunday|last)|any (update|news)|updates?\b|shipped|new release|price (rise|increase|drop|cut)|re-?check|verify)/i.test(message);
}

// Words too generic to identify an item in a search query ("Zoho CRM" is identified by "zoho").
const GENERIC = new Set(["crm", "pro", "plan", "plans", "cloud", "sales", "hub", "the", "and", "app", "inc", "ltd", "platform", "software", "tool", "tools", "enterprise", "professional", "growth", "basic", "starter", "team"]);

function keyWords(item: string): string[] {
  return item
    .toLowerCase()
    .split(/[^a-z0-9.+#-]+/)
    .filter((w) => w.length >= 3 && !GENERIC.has(w));
}

/** Items from the recalled exchanges that a re-check should cover (deduplicated, capped). */
export function recheckItems(entityLists: (string[] | undefined)[], max = 10): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of entityLists)
    for (const e of list ?? []) {
      const key = keyWords(e).join(" ") || e.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(e);
      }
    }
  return out.slice(0, max);
}

/** Checklist items that no search query this turn mentioned. */
export function unverifiedItems(items: string[], searches: string[]): string[] {
  const queries = searches.map((q) => q.toLowerCase());
  return items.filter((item) => {
    const words = keyWords(item);
    if (!words.length) return false; // nothing distinctive to check against
    return !queries.some((q) => words.some((w) => q.includes(w)));
  });
}
