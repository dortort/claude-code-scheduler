/**
 * humanize subcommand: converts cron expressions to human-readable
 * descriptions and computes next run times for a batch of tasks.
 *
 * Used by /scheduler:list to humanize cron expressions without
 * requiring direct access to the plugin's dist directory.
 */

import { cronToHuman } from '../../cron/humanizer.js';
import { getNextRuns } from '../../cron/parser.js';

export interface HumanizeInput {
  id: string;
  cron: string;
}

export interface HumanizeOutput {
  id: string;
  human: string;
  next: string | null;
  relativeTime: string | null;
}

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export function formatRelativeTime(next: Date | undefined): string | null {
  if (next === undefined) return null;

  const now = new Date();

  // Compare UTC dates
  const nowUtcDate = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const nextUtcDate = Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate());

  const diffMs = next.getTime() - now.getTime();

  // Build delta string
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  let delta: string;
  if (totalMinutes < 1) {
    delta = '~in <1m';
  } else {
    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    delta = `~in ${parts.join(' ')}`;
  }

  // Build time string (12-hour UTC)
  const utcHour = next.getUTCHours();
  const utcMinute = next.getUTCMinutes();
  const ampm = utcHour < 12 ? 'AM' : 'PM';
  const hour12 = utcHour % 12 === 0 ? 12 : utcHour % 12;
  const minuteStr = utcMinute.toString().padStart(2, '0');
  const timeStr = `${hour12}:${minuteStr} ${ampm} UTC`;

  const dayAbbr = DAY_ABBR[next.getUTCDay()];

  const dayDiff = (nextUtcDate - nowUtcDate) / (1000 * 60 * 60 * 24);

  let dayLabel: string;
  if (dayDiff === 0) {
    dayLabel = 'Today';
  } else if (dayDiff === 1) {
    dayLabel = 'Tomorrow';
  } else {
    dayLabel = DAY_ABBR[next.getUTCDay()];
  }

  return `${dayLabel} (${dayAbbr}) at ${timeStr}, ${delta}`;
}

export function humanize(tasks: HumanizeInput[]): HumanizeOutput[] {
  return tasks.map(({ id, cron }) => {
    const nextDate = getNextRuns(cron, 1)[0];
    return {
      id,
      human: cronToHuman(cron),
      next: nextDate?.toISOString() ?? null,
      relativeTime: formatRelativeTime(nextDate),
    };
  });
}
