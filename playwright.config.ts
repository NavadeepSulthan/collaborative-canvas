import { defineConfig, devices } from '@playwright/test';

const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run dev -w @canvas/server',
      url: 'http://localhost:4000/healthz',
      reuseExistingServer: !CI,
      env: { LOG_LEVEL: 'warn' },
    },
    {
      command: 'npm run dev -w @canvas/web',
      url: 'http://localhost:5173',
      reuseExistingServer: !CI,
    },
  ],
});
