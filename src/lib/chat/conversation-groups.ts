/**
 * Recency buckets for the conversation sidebar.
 *
 * The list arrives ordered newest-first, so these groups preserve that order
 * and only add structure the eye can use to scroll: today's work, the
 * yesterday-you-left-it set, the past week, then everything else. Empty
 * buckets are dropped — a heading with nothing under it is noise.
 *
 * Buckets are LOCAL calendar days. The browser runs this, so "Today" is the
 * viewer's today; a UTC bucket would file last night's work under tomorrow
 * for anyone west of London.
 */

export type RecencyBucket = "today" | "yesterday" | "week" | "older";

export interface GroupableConversation {
  id: string;
  updatedAt: string;
}

export interface ConversationGroup<T extends GroupableConversation> {
  key: RecencyBucket;
  label: string;
  items: T[];
}

const LABELS: Record<RecencyBucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "Previous 7 days",
  older: "Older",
};

const ORDER: RecencyBucket[] = ["today", "yesterday", "week", "older"];

function bucketOf(updatedAt: string, now: Date): RecencyBucket {
  const then = new Date(updatedAt);
  if (Number.isNaN(then.getTime())) return "older";

  const dayStart = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

  const diffDays = Math.round((dayStart(now) - dayStart(then)) / 86_400_000);
  // A negative diff is clock skew (server ahead of the browser): showing it
  // under "Today" is honest, hiding it in "Older" is not.
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays <= 7) return "week";
  return "older";
}

export function groupByRecency<T extends GroupableConversation>(
  conversations: T[],
  now: Date,
): ConversationGroup<T>[] {
  const buckets = new Map<RecencyBucket, T[]>();
  for (const c of conversations) {
    const key = bucketOf(c.updatedAt, now);
    const list = buckets.get(key);
    if (list) list.push(c);
    else buckets.set(key, [c]);
  }
  return ORDER.flatMap((key) => {
    const items = buckets.get(key);
    return items ? [{ key, label: LABELS[key], items }] : [];
  });
}
