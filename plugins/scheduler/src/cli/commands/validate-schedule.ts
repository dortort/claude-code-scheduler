/**
 * validate-schedule subcommand: validates a schedule input and returns
 * the resolved cron expression, human-readable description, and next runs.
 *
 * Used by /scheduler:add and /scheduler:edit skills to validate schedules
 * without requiring direct access to the plugin's dist directory.
 */

import { naturalLanguageToCron, validateCron, getNextRuns, CRON_PRESETS } from '../../cron/parser.js';
import { cronToHuman } from '../../cron/humanizer.js';

export interface ValidateScheduleResult {
  cron: string;
  human: string;
  nextRuns: string[];
}

export interface ValidateScheduleError {
  error: string;
}

export function validateSchedule(input: string): ValidateScheduleResult | ValidateScheduleError {
  const trimmed = input.trim();
  let cron = trimmed;

  // Try natural language conversion
  const nlResult = naturalLanguageToCron(trimmed);
  if (nlResult) {
    cron = nlResult;
  }

  // Check presets
  const preset = CRON_PRESETS[trimmed.toLowerCase()];
  if (preset) {
    cron = preset;
  }

  // Validate
  const v = validateCron(cron);
  if (!v.valid) {
    return { error: v.error ?? 'Invalid cron expression' };
  }

  const human = cronToHuman(cron);
  const nextRuns = getNextRuns(cron, 3).map(d => d.toISOString());

  return { cron, human, nextRuns };
}
