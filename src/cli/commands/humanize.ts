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
  timezone?: string;
}

export interface HumanizeOutput {
  id: string;
  human: string;
  next: string | null;
  relativeTime: string | null;
}

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * Format a Date for display in the given IANA timezone (or local if not specified).
 * Uses Intl.DateTimeFormat for timezone-aware formatting.
 */
function getDateParts(date: Date, timezone?: string): { hour: number; minute: number; day: number; dateStr: string; tzLabel: string } {
  const tz = timezone && timezone !== 'local' ? timezone : undefined;
  const tzLabel = tz ?? 'local';

  if (tz) {
    const hourFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz });
    const minuteFmt = new Intl.DateTimeFormat('en-US', { minute: 'numeric', timeZone: tz });
    const dayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz });
    const dateFmt = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz });

    const hour = parseInt(hourFmt.format(date), 10);
    const minute = parseInt(minuteFmt.format(date), 10);
    const dayName = dayFmt.format(date);
    const dayIndex = DAY_ABBR.indexOf(dayName as typeof DAY_ABBR[number]);
    const dateStr = dateFmt.format(date);

    return { hour, minute, day: dayIndex >= 0 ? dayIndex : date.getUTCDay(), dateStr, tzLabel: tz };
  }

  // Local timezone
  return {
    hour: date.getHours(),
    minute: date.getMinutes(),
    day: date.getDay(),
    dateStr: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    tzLabel,
  };
}

export function formatNextRunTime(next: Date | undefined, timezone?: string): string | null {
  if (next === undefined) return null;

  const now = new Date();
  const nextParts = getDateParts(next, timezone);
  const nowParts = getDateParts(now, timezone);

  const diffMs = next.getTime() - now.getTime();
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

  const ampm = nextParts.hour < 12 ? 'AM' : 'PM';
  const hour12 = nextParts.hour % 12 === 0 ? 12 : nextParts.hour % 12;
  const timeStr = `${hour12}:${nextParts.minute.toString().padStart(2, '0')} ${ampm} ${nextParts.tzLabel}`;

  const dayAbbr = DAY_ABBR[nextParts.day];
  const dayLabel = nextParts.dateStr === nowParts.dateStr ? 'Today' : dayAbbr;

  // Check if tomorrow by comparing date strings
  const tomorrowDate = new Date(now.getTime() + 86400000);
  const tomorrowParts = getDateParts(tomorrowDate, timezone);
  if (nextParts.dateStr === tomorrowParts.dateStr) {
    return `Tomorrow (${dayAbbr}) at ${timeStr}, ${delta}`;
  }

  return `${dayLabel} (${dayAbbr}) at ${timeStr}, ${delta}`;
}

export function humanize(tasks: HumanizeInput[]): HumanizeOutput[] {
  return tasks.map(({ id, cron, timezone }) => {
    const nextDate = getNextRuns(cron, 1, timezone)[0];
    return {
      id,
      human: cronToHuman(cron),
      next: nextDate?.toISOString() ?? null,
      relativeTime: formatNextRunTime(nextDate, timezone),
    };
  });
}
