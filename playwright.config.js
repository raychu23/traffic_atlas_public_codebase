const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3107',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run client',
    env: {
      ...process.env,
      BROWSER: 'none',
      HOST: '127.0.0.1',
      PORT: '3107',
      REACT_APP_API_URL_TESTING: 'http://127.0.0.1:3107/api',
    },
    reuseExistingServer: false,
    timeout: 180_000,
    url: 'http://127.0.0.1:3107',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
