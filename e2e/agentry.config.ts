import { defineConfig } from 'agentry';

export default defineConfig({
  testDir: '.',
  mode: 'live',
  use: { agent: 'claude', model: 'claude-haiku-4-5' },
  timeout: 120_000,
  // Live agent runs vary in phrasing/path; retry a flaky scenario before failing.
  retries: 2,
  budget: { perTest: { usd: 1 } },
});
