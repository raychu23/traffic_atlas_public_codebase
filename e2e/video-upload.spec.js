const { expect, test } = require('@playwright/test');

// Browser workflow tests use HTTP fixtures. They do not exercise Cognito,
// video decoding, S3, EC2, or GPU inference; those require deployment checks.
const user = { userId: 'browser-fixture', name: 'Test Uploader', email: 'test@example.com', isAdmin: false };

async function signInFixture(page) {
  const claims = Buffer.from(JSON.stringify({ sub: user.userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('authToken', token);
    localStorage.setItem('userId', user.userId);
    localStorage.setItem('userName', user.name);
    localStorage.setItem('userEmail', user.email);
    localStorage.setItem('userIsAdmin', 'false');
  }, { token: `eyJhbGciOiJIUzI1NiJ9.${claims}.browser-fixture`, user });
}

async function mockApi(page, handler = async () => false) {
  await page.route('**/api/**', async (route) => {
    const endpoint = new URL(route.request().url()).pathname;
    if (await handler(route, endpoint)) return;
    if (endpoint === '/api/auth/me') return route.fulfill({ json: { success: true, user } });
    if (endpoint === '/api/notifications') return route.fulfill({ json: { success: true, messages: 0, requests: 0 } });
    if (endpoint === '/api/legal/upload-terms') return route.fulfill({ json: { success: true, documents: [], termsVersion: 'fixture-terms' } });
    await route.fulfill({ status: 404, json: { error: `Unexpected fixture request: ${endpoint}` } });
  });
}

test('logged-out users must sign in for both upload workflows', async ({ page }) => {
  await mockApi(page);
  for (const route of ['/upload', '/upload/metadata', '/upload/video', '/upload/video/details']) {
    await page.goto(route);
    await expect(page).toHaveURL(/\/login$/);
  }
});

test('combined chooser opens the video workflow and rejects unsupported files', async ({ page }) => {
  await signInFixture(page);
  await mockApi(page);
  await page.goto('/upload');
  await expect(page.getByRole('button', { name: 'Start Dataset Upload' })).toBeVisible();
  await page.getByRole('button', { name: 'Start Video Upload' }).click();
  await expect(page).toHaveURL(/\/upload\/video$/);
  await page.locator('input[type="file"]').setInputFiles({ name: 'traffic.txt', mimeType: 'text/plain', buffer: Buffer.from('not a video') });
  await expect(page.getByRole('alert')).toContainText('Unsupported video format');
});

test('sample ZIP gate preserves metadata, terms and multipart dataset submission', async ({ page }) => {
  await signInFixture(page);
  let completion;
  let uploadedPart;
  await mockApi(page, async (route, endpoint) => {
    if (endpoint.endsWith('/multipart/initiate')) {
      expect(route.request().postDataJSON().fileName).toBe('sample.zip');
      await route.fulfill({ json: { success: true, session: { requestId: 'fixture-request', partSize: 1024 } } });
    } else if (endpoint.endsWith('/multipart/parts')) {
      await route.fulfill({ json: { success: true, parts: [] } });
    } else if (endpoint.endsWith('/multipart/part-url')) {
      await route.fulfill({ json: { success: true, url: 'http://127.0.0.1:3107/fixture-s3/part-1' } });
    } else if (endpoint.endsWith('/multipart/complete')) {
      completion = route.request().postDataJSON();
      await route.fulfill({ json: { success: true, requestId: 'fixture-request' } });
    } else return false;
    return true;
  });
  await page.route('**/fixture-s3/part-1', async (route) => {
    expect(route.request().method()).toBe('PUT');
    uploadedPart = route.request().postDataBuffer();
    await route.fulfill({ status: 200, headers: { ETag: '"fixture-part"' }, body: '' });
  });
  await page.goto('/upload');
  await page.getByRole('button', { name: 'Start Dataset Upload' }).click();
  await expect(page.getByRole('heading', { name: 'Submit a dataset', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Continue/ }).click();
  await expect(page.locator('.upload-error-body')).toContainText('Please upload a sample dataset ZIP file');
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  const zip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
  await page.locator('#datasetSampleZipFile').setInputFiles({ name: 'sample.zip', mimeType: 'application/zip', buffer: zip });
  await page.getByRole('button', { name: /^Continue/ }).click();
  await page.locator('#title').fill('Intersection dataset');
  await page.locator('#description').fill('Representative traffic data collected from an intersection camera.');
  await page.locator('#category').selectOption('Dataset');
  await page.locator('#owner_name_or_org').fill('Test Lab');
  await page.locator('#source').fill('Traffic camera');
  await page.locator('#funded_by_text').fill('Test Lab');
  await page.locator('#license').selectOption('MIT');
  await page.locator('#access_level').selectOption('Public');
  await expect(page.locator('#contact_email')).toHaveValue(user.email);
  await page.getByRole('button', { name: /^Continue/ }).click();
  await expect(page.locator('.file-picked-container')).toContainText('sample.zip');
  await page.locator('#sample_guidelines_ack').check();
  await page.getByRole('button', { name: /^Continue/ }).click();
  for (const id of ['terms_and_conditions_accept', 'rights_confirmation_accept', 'privacy_compliance_accept']) await page.locator(`#${id}`).check();
  await page.getByRole('button', { name: 'Submit Request', exact: true }).click();
  await expect(page.getByText('Submission request sent (ID: fixture-request).')).toBeVisible();
  expect(uploadedPart).toEqual(zip);
  expect(completion.parts).toEqual([{ PartNumber: 1, ETag: '"fixture-part"' }]);
  expect(completion.metadata).toMatchObject({ title: 'Intersection dataset', uploaded_by: user.userId, terms_version_accepted: 'fixture-terms', terms_and_conditions_accept: true, rights_confirmation_accept: true, privacy_compliance_accept: true });
});

test('video upload renders paths and endpoints, saves dragged zones and downloads updated counts', async ({ page }) => {
  await signInFixture(page);
  const videoId = '11111111-1111-4111-8111-111111111111';
  const zone = { id: 'zone-1', label: 'Zone 1', color: '#00847c', points: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }] };
  let job = {
    videoId, fileName: 'intersection.mp4', durationSeconds: 60, width: 1280, height: 960,
    status: 'ready', countsStatus: 'ready', zoneSuggestionMethod: 'kmeans-convex-hull',
    zones: [zone], suggestedZones: [zone], trafficScene: { confidence: 'high' },
    artifacts: { preview: true, countsCsv: true },
    trajectories: [{ trackId: 1, points: [{ x: 15, y: 15 }, { x: 40, y: 40 }, { x: 80, y: 70 }] }],
    counts: [{ bin_start_s: 0, bin_end_s: 900, class: 'car', from_zone: 'Zone 1', to_zone: 'Zone 2', count: 4 }],
  };
  let savedZones;
  await mockApi(page, async (route, endpoint) => {
    if (endpoint === '/api/videos/validate-upload') {
      expect(route.request().headers()['content-type']).toContain('multipart/form-data; boundary=');
      expect(route.request().postData()).toContain('filename="intersection.mp4"');
      await route.fulfill({ json: { success: true, video: job } });
    } else if (endpoint === `/api/videos/${videoId}`) {
      await route.fulfill({ json: { success: true, video: job } });
    } else if (endpoint.endsWith('/artifacts/preview')) {
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="960"><rect width="1280" height="960" fill="#444"/></svg>' });
    } else if (endpoint.endsWith('/zones')) {
      savedZones = route.request().postDataJSON().zones;
      job = { ...job, zones: savedZones, counts: [{ ...job.counts[0], count: 5 }] };
      await route.fulfill({ json: { success: true, video: job } });
    } else if (endpoint.endsWith('/artifacts/counts')) {
      await route.fulfill({ contentType: 'text/csv', body: 'class,from_zone,to_zone,count\ncar,Zone 1,Zone 2,5\n' });
    } else return false;
    return true;
  });
  await page.goto('/upload/video');
  await page.locator('input[type="file"]').setInputFiles({ name: 'intersection.mp4', mimeType: 'application/octet-stream', buffer: Buffer.from('HTTP fixture video bytes') });
  await page.getByRole('button', { name: /Continue/ }).click();
  await expect(page).toHaveURL(/\/upload\/video\/details$/);
  await expect(page.locator('.trajectory-path')).toHaveAttribute('points', '15,15 40,40 80,70');
  await expect(page.locator('.trajectory-path')).toBeVisible();
  await expect(page.locator('.trajectory-start')).toHaveAttribute('cx', '15');
  await expect(page.locator('.trajectory-end')).toHaveAttribute('cx', '80');
  await expect(page.getByText('4 total vehicles')).toBeVisible();
  const handle = page.locator('.zone-handle-hit').first();
  await handle.scrollIntoViewIfNeeded();
  const bounds = await handle.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 25, bounds.y + bounds.height / 2 + 20, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByText('5 total vehicles')).toBeVisible();
  expect(savedZones[0].points[0].x).toBeGreaterThan(10);
  expect(savedZones[0].points[0].y).toBeGreaterThan(10);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe(`${videoId}-movement-counts.csv`);
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toContain('car,Zone 1,Zone 2,5');
  await page.screenshot({ path: test.info().outputPath('video-review.png'), fullPage: true });
});
