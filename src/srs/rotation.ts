/**
 * Which example sentence to show for a card.
 *
 * - First exposure (card never answered): the business example, so the word is
 *   first tied to a work situation.
 * - After that the example rotates with each review (business → daily →
 *   alternative), so the meaning is not memorised as one fixed sentence.
 *
 * Reading and Speaking cards rotate independently (each uses its own review
 * count). Only the display changes; scheduling is untouched.
 */
import type { Example, ExampleKind, ReviewCard } from '../db/types';

const ORDER: ExampleKind[] = ['business', 'daily', 'alternative'];

export function orderedExamples(examples: Example[]): Example[] {
  const rank = (e: Example) => {
    const i = ORDER.indexOf(e.kind);
    return i === -1 ? ORDER.length : i;
  };
  return examples
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i)
    .map((x) => x.e);
}

export function pickExample(
  examples: Example[],
  card: Pick<ReviewCard, 'fsrs' | 'introducedAt'>,
  usable: (e: Example) => boolean = () => true,
): { main: Example | undefined; others: Example[] } {
  const all = orderedExamples(examples);
  const pool = all.filter(usable);
  if (pool.length === 0) return { main: undefined, others: all };
  const step = card.introducedAt === null ? 0 : card.fsrs.reps % pool.length;
  const main = pool[step];
  return { main, others: all.filter((e) => e !== main) };
}
