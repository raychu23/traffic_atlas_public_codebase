const { expect, test } = require('@playwright/test');

test('selects the video workflow and rejects unsupported files', async ({ page }) => {
  await page.goto('/upload');

  await page.getByRole('button', { name: 'Start Video Upload' }).click();
  await expect(page).toHaveURL(/\/upload\/video$/);

  await page.locator('input[type="file"]').setInputFiles({
    name: 'traffic.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not a video'),
  });

  await expect(page.getByRole('alert')).toContainText('Unsupported video format');
});
