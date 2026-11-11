/**
 * Everything time-related happens in the *user's* timezone: "what did I ask on
 * 3 November" means 3 November where the user lives, not in UTC on the server.
 */

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** YYYY-MM-DD of an instant, as seen in `tz`. */
export function localDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** "Tue 3 Nov 2026, 14:05" in `tz`. */
export function humanDateTime(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")}`;
}

function utcOffset(d: Date, tz: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName")?.value;
  return name === "GMT" ? "UTC+00:00" : (name ?? "").replace("GMT", "UTC");
}

/**
 * A small calendar the model can read instead of doing date arithmetic.
 * LLMs are unreliable at "which date was last Tuesday?"; a lookup table is not.
 */
export function temporalContext(now: Date, tz: string, days = 21): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const lines: string[] = [];
  for (let i = 0; i < days; i++) {
    // Step back in 24h increments from local noon-ish to avoid DST edge cases.
    const d = new Date(now.getTime() - i * 86_400_000);
    const label = i === 0 ? " (today)" : i === 1 ? " (yesterday)" : "";
    lines.push(`- ${localDate(d, tz)}: ${fmt.format(d)}${label}`);
  }
  return [
    `Current date and time for the user: ${fmt.format(now)}, ${humanDateTime(now, tz).split(", ")[1]} (${tz}, ${utcOffset(now, tz)}).`,
    `Calendar of the last ${days} days (use this to resolve "Monday", "last Tuesday", "3 November", etc.):`,
    ...lines,
  ].join("\n");
}
