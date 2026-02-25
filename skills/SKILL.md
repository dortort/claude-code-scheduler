---
trigger: "schedule a|schedule this|set up a schedule|create a schedule|add a scheduled"
---

# Schedule a Task

You want to schedule a recurring or one-time AI-assisted task. I'll help you set that up.

## What I need from you

1. **What should Claude do?** Describe the task as a natural-language prompt (e.g., "Review the latest commits and summarize changes").

2. **When should it run?** Describe the schedule in natural language (e.g., "every day at 9am", "every weekday at 5pm", "every Monday at 10am") or provide a cron expression.

3. **Where should it run?** The working directory for the task (defaults to your current project).

## Options

- **Worktree mode**: Run in an isolated git worktree to avoid interfering with your working copy. Changes are committed to a branch and pushed.
- **Timeout**: Maximum execution time (default: 5 minutes).
- **Skip permissions**: Run without permission prompts (requires global config, not available in project configs).

## Process

I will use the `/schedule-add` command to:
1. Parse your schedule into a cron expression
2. Show you when the next 3 runs will be
3. Register the task with your OS scheduler (launchd on macOS, crontab on Linux)

## Examples

- "Schedule a daily code review at 9am"
- "Set up a schedule to check for dependency updates every Monday"
- "Schedule this: summarize the git log every weekday at 5pm"
