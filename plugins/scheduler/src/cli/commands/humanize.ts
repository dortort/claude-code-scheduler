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

interface DateParts {
  hour: number;
  minute: number;
  day: number;
  year: number;
  month: number;
  date: number;
  tzLabel: string;
}

function getDateParts(d: Date, timezone?: string): DateParts {
  const tz = timezone && timezone !== 'local' ? timezone : undefined;
  const tzLabel = tz ?? 'local';

  if (tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: 'numeric', weekday: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour12: false, timeZone: tz,
    }).formatToParts(d);

    const get = (type: string) => {
      const p = parts.find(p => p.type === type);
      return p ? parseInt(p.value, 10) : 0;
    };
    const dayName = parts.find(p => p.type === 'weekday')?.value ?? '';
    const dayIndex = DAY_ABBR.indexOf(dayName as typeof DAY_ABBR[number]);

    return {
      hour: get('hour') % 24,
      minute: get('minute'),
      day: dayIndex >= 0 ? dayIndex : d.getUTCDay(),
      year: get('year'),
      month: get('month'),
      date: get('day'),
      tzLabel: tz,
    };
  }

  return {
    hour: d.getHours(),
    minute: d.getMinutes(),
    day: d.getDay(),
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    date: d.getDate(),
    tzLabel,
  };
}

function sameDate(a: DateParts, b: DateParts): boolean {
  return a.year === b.year && a.month === b.month && a.date === b.date;
}

function nextCalendarDay(parts: DateParts): { year: number; month: number; date: number } {
  // Use Date to handle month/year rollovers
  const d = new Date(parts.year, parts.month - 1, parts.date + 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1, date: d.getDate() };
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

  let dayLabel: string;
  if (sameDate(nextParts, nowParts)) {
    dayLabel = 'Today';
  } else {
    const tomorrow = nextCalendarDay(nowParts);
    if (nextParts.year === tomorrow.year && nextParts.month === tomorrow.month && nextParts.date === tomorrow.date) {
      dayLabel = 'Tomorrow';
    } else {
      dayLabel = dayAbbr;
    }
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
