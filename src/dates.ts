import { localDate } from "./time.ts";

/**
 * Deterministic resolution of the date phrases people use about past
 * conversations ("yesterday", "on Monday", "last Tuesday", "3 November",
 * "a few days ago", "last week"), in the user's timezone.
 *
 * Done in code, not by the model, so it is exact and unit-tested, and so the
 * memory lookup can happen before the model is called (no extra round trip,
 * and web search stays the model's only tool). Genuinely ambiguous phrases
 * return every plausible reading; the model is told which one it got.
 */

export interface DateRef {
  /** The phrase as written, e.g. "last Tuesday". */
  phrase: string;
  /** Inclusive local dates, YYYY-MM-DD. */
  from: string;
  to: string;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// Y-M-D arithmetic in UTC so DST never matters (same approach as the calendar).
const parse = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const fmt = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (ymd: string, n: number) => {
  const d = parse(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
};
export const weekday = (ymd: string) => parse(ymd).getUTCDay();
/** Monday of the week containing `ymd`. */
const mondayOf = (ymd: string) => addDays(ymd, -((weekday(ymd) + 6) % 7));

function num(word: string): number | undefined {
  return /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word];
}

/** Explicit calendar date with optional year; a date that would be in the future means last year. */
function calendarDate(day: number, monthIdx: number, year: number | undefined, today: string): string | undefined {
  const y = year ?? Number(today.slice(0, 4));
  const d = new Date(Date.UTC(y, monthIdx, day));
  if (d.getUTCMonth() !== monthIdx) return undefined; // e.g. 31 November
  const ymd = fmt(d);
  return year === undefined && ymd > today ? fmt(new Date(Date.UTC(y - 1, monthIdx, day))) : ymd;
}

export function resolveDates(message: string, now: Date, tz: string): DateRef[] {
  const today = localDate(now, tz);
  const text = message.toLowerCase().replace(/[’']/g, "'");
  const refs: DateRef[] = [];
  const add = (phrase: string, from: string, to = from) => {
    if (from > today) return;
    if (!refs.some((r) => r.from === from && r.to === to)) refs.push({ phrase, from, to: to > today ? today : to });
  };
  let m: RegExpExecArray | null;

  // Relative days.
  if (/\b(day before yesterday)\b/.test(text)) add("the day before yesterday", addDays(today, -2));
  else if (/\byesterday\b/.test(text)) add("yesterday", addDays(today, -1));
  if (/\b(this morning|this afternoon|earlier today|tonight)\b/.test(text)) add("today", today);
  // A bare "today" ("is it still correct today?") usually means now, not a past
  // chat. It only counts when it's the sole date in the message (checked at the end).
  const bareToday = /\btoday\b/.test(text);
  for (const r of text.matchAll(/\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|a couple of|a few)\s+days?\s+ago\b/g)) {
    if (r[1] === "a couple of") add(r[0], addDays(today, -3), addDays(today, -2));
    else if (r[1] === "a few") add(r[0], addDays(today, -5), addDays(today, -2));
    else if (num(r[1]) !== undefined) add(r[0], addDays(today, -num(r[1])!));
  }
  for (const r of text.matchAll(/\b(\d+|a|an|one|two|three|four|a couple of)\s+weeks?\s+ago\b/g)) {
    const n = r[1] === "a couple of" ? 2 : num(r[1]);
    if (n !== undefined) add(r[0], addDays(today, -7 * n - 3), addDays(today, -7 * n + 3));
  }

  // Weeks and months.
  if (/\b(the )?week before last\b/.test(text)) add("the week before last", addDays(mondayOf(today), -14), addDays(mondayOf(today), -8));
  else if (/\b(last|previous) week\b/.test(text)) add("last week", addDays(mondayOf(today), -7), addDays(mondayOf(today), -1));
  if (/\b(this week|earlier this week)\b/.test(text)) add("this week", mondayOf(today), today);
  if (/\blast month\b/.test(text)) {
    const t = parse(today);
    const first = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1));
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0));
    add("last month", fmt(first), fmt(last));
  }

  // Weekdays: "Monday", "on Monday", "last Tuesday", "this past Friday".
  // A weekday followed by ".com"/".io" etc. is a product name (Monday.com), and
  // "next/coming/upcoming Monday" is the future: neither is a past date.
  const wd = /\b(next|coming|upcoming|this coming|last|previous|this past|past|on|this)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b(?!\.[a-z])/g;
  while ((m = wd.exec(text))) {
    if (m[1] && /next|coming|upcoming/.test(m[1])) continue;
    const target = WEEKDAYS.indexOf(m[2]);
    let recent = addDays(today, -1);
    while (weekday(recent) !== target) recent = addDays(recent, -1); // most recent, strictly before today
    const phrase = m[0].trim();
    add(phrase, recent);
    // "last Tuesday" said on a Wednesday can mean yesterday or the week before: offer both.
    if ((m[1] === "last" || m[1] === "previous") && recent >= mondayOf(today)) add(phrase, addDays(recent, -7));
  }

  // Explicit dates: "3 November", "3rd of Nov 2026", "November 3", "Nov 3rd, 2026", "2026-11-03".
  const dm = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b(?:,?\\s+(\\d{4}))?`, "g");
  while ((m = dm.exec(text))) {
    const d = calendarDate(Number(m[1]), MONTHS.indexOf(m[2].slice(0, 3)), m[3] ? Number(m[3]) : undefined, today);
    if (d) add(m[0], d);
  }
  const md = new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "g");
  while ((m = md.exec(text))) {
    const d = calendarDate(Number(m[2]), MONTHS.indexOf(m[1].slice(0, 3)), m[3] ? Number(m[3]) : undefined, today);
    if (d) add(m[0], d);
  }
  for (const r of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const d = calendarDate(Number(r[3]), Number(r[2]) - 1, Number(r[1]), today);
    if (d) add(r[0], d);
  }
  if (bareToday && refs.length === 0) add("today", today);
  return refs;
}

/** Does the message refer to an earlier conversation, even without a date? */
export function refersToPast(message: string): boolean {
  const t = message.toLowerCase().replace(/[’']/g, "'");
  return [
    // "I asked", "we shortlisted", "did I ask", "what did we discuss", "have we talked about"
    /\b(i|we)\s+(asked|discussed|talked|shortlisted|chose|picked|decided|compared|looked at|mentioned|said|told you|researched|searched)\b/,
    /\b(did|have|had)\s+(i|we)\s+(ask|discuss|talk|shortlist|choose|pick|decide|compare|look|mention|say|tell)\b/,
    // "you said", "did you say", "your answer", "you told me"
    /\byou\s+(said|told|recommended|suggested|answered|mentioned|gave|listed|found|claimed)\b/,
    /\bdid you\s+(say|tell|recommend|suggest|answer|mention|find)\b/,
    /\byour (answer|reply|recommendation|response)\b/,
    // "last time", "our chat", "remember when", "since then", "previously"
    /\b(last time|previously|since then|remember|we were|our (chat|conversation|discussion)|that (chat|conversation|discussion))\b/,
    // "my last question", "the other chat", "in our previous conversation", "what have we talked about"
    /\bmy (last|previous|earlier|first|other) (question|message|chat)s?\b/,
    /\b(previous|last|other|earlier|old|past) (chat|conversation|discussion|session)s?\b/,
  ].some((re) => re.test(t));
}
