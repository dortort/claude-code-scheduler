import { defineConfig } from 'agentry';

export default defineConfig({
  testDir: '.',
  mode: 'live',
  use: { agent: 'claude', model: 'claude-haiku-4-5' },
  timeout: 120_000,
  budget: { perTest: { usd: 1 } },
});
