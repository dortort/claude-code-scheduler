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
}

export function humanize(tasks: HumanizeInput[]): HumanizeOutput[] {
  return tasks.map(({ id, cron }) => ({
    id,
    human: cronToHuman(cron),
    next: getNextRuns(cron, 1)[0]?.toISOString() ?? null,
  }));
}
