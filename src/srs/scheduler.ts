/**
 * Thin wrapper around ts-fsrs (the official TypeScript implementation of FSRS
 * maintained by the open-spaced-repetition project). No scheduling maths is
 * implemented here — we only convert between our serialised shape and the
 * library's `Card`, and configure parameters from user settings.
 */
import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  State,
  type Card,
  type FSRS,
  type Grade,
} from 'ts-fsrs';
import type { FsrsCardData, RatingValue, Settings } from '../db/types';

export { Rating, State };

export function toFsrsCard(d: FsrsCardData): Card {
  return {
    due: new Date(d.due),
    stability: d.stability,
    difficulty: d.difficulty,
    elapsed_days: d.elapsed_days,
    scheduled_days: d.scheduled_days,
    learning_steps: d.learning_steps,
    reps: d.reps,
    lapses: d.lapses,
    state: d.state as State,
    last_review: d.last_review ? new Date(d.last_review) : undefined,
  };
}

export function fromFsrsCard(c: Card): FsrsCardData {
  const out: FsrsCardData = {
    due: c.due.toISOString(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    learning_steps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
  };
  if (c.last_review) out.last_review = c.last_review.toISOString();
  return out;
}

export function newCardData(now = new Date()): FsrsCardData {
  return fromFsrsCard(createEmptyCard(now));
}

let cached: { key: string; f: FSRS } | null = null;

export function getScheduler(settings: Pick<Settings, 'desiredRetention' | 'maximumIntervalDays' | 'enableFuzz'>): FSRS {
  const key = `${settings.desiredRetention}|${settings.maximumIntervalDays}|${settings.enableFuzz}`;
  if (cached?.key === key) return cached.f;
  const params = generatorParameters({
    request_retention: settings.desiredRetention,
    maximum_interval: settings.maximumIntervalDays,
    enable_fuzz: settings.enableFuzz,
    enable_short_term: true,
  });
  const f = fsrs(params);
  cached = { key, f };
  return f;
}

export function schedule(
  settings: Pick<Settings, 'desiredRetention' | 'maximumIntervalDays' | 'enableFuzz'>,
  card: FsrsCardData,
  rating: RatingValue,
  now = new Date(),
): FsrsCardData {
  const f = getScheduler(settings);
  const result = f.next(toFsrsCard(card), now, rating as Grade);
  return fromFsrsCard(result.card);
}

/** Preview the next interval for each rating (shown under the answer buttons). */
export function previewIntervals(
  settings: Pick<Settings, 'desiredRetention' | 'maximumIntervalDays' | 'enableFuzz'>,
  card: FsrsCardData,
  now = new Date(),
): Record<RatingValue, number> {
  const f = getScheduler({ ...settings, enableFuzz: false });
  const preview = f.repeat(toFsrsCard(card), now);
  const days = (r: Grade) => (preview[r].card.due.getTime() - now.getTime()) / 86400_000;
  return {
    1: days(Rating.Again),
    2: days(Rating.Hard),
    3: days(Rating.Good),
    4: days(Rating.Easy),
  };
}

/** Current probability of recall (0..1). Returns null for never-reviewed cards. */
export function retrievability(
  settings: Pick<Settings, 'desiredRetention' | 'maximumIntervalDays' | 'enableFuzz'>,
  card: FsrsCardData,
  now = new Date(),
): number | null {
  if (card.state === State.New || !card.last_review) return null;
  return getScheduler(settings).get_retrievability(toFsrsCard(card), now, false);
}
