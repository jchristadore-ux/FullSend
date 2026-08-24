/**
 * Local dev helper: drives a full FullSend session in a real browser — sign in,
 * create a project from the GitHub fixture, run the queue, approve the
 * strategy, then screenshot each page.
 *
 * Not part of the shipped app. Requires `npm run dev` and the fixture server.
 *
 *   node scripts/dev-drive.mjs <outDir>
 */
import { chromium } from 'playwright';

const outDir = process.argv[2] ?? '/tmp';
const base = process.env.BASE ?? 'http://localhost:3100';
const repo = process.env.FIXTURE_SLUG ?? 'acme/taskflow';

const browser = await chromium.launch({
  // Set CHROME_PATH to use a specific binary; otherwise Playwright's own.
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--no-sandbox'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  [browser error]', m.text().slice(0, 160));
});

/** Runs fetch inside the page so session cookies apply automatically. */
const api = (path, init) =>
  page.evaluate(
    async ([p, i]) => {
      const res = await fetch(p, i ? { ...i, headers: { 'Content-Type': 'application/json' } } : undefined);
      const text = await res.text();
      try {
        return { status: res.status, body: JSON.parse(text) };
      } catch {
        return { status: res.status, body: text.slice(0, 300) };
      }
    },
    [path, init],
  );

await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });

const signin = await api('/api/auth/signin', {
  method: 'POST',
  body: JSON.stringify({ email: 'founder@example.com' }),
});
console.log('signin:', signin.status);
if (signin.status !== 200) {
  console.error('sign-in failed:', JSON.stringify(signin.body));
  await browser.close();
  process.exit(1);
}

const created = await api('/api/projects', {
  method: 'POST',
  body: JSON.stringify({ repository: repo }),
});
const projectId = created.body?.project?.id;
console.log('project:', created.status, projectId ?? JSON.stringify(created.body).slice(0, 200));
if (!projectId) {
  await browser.close();
  process.exit(1);
}

const tick = async (n) => {
  for (let i = 0; i < n; i++) await api(`/api/projects/${projectId}/tick`, { method: 'POST' });
};

await tick(3);
await api(`/api/projects/${projectId}/strategy`, { method: 'POST', body: '{}' });
await tick(5);

const content = await api(`/api/projects/${projectId}/content`);
console.log('content:', content.body?.total, JSON.stringify(content.body?.counts));

await ctx.addCookies([
  { name: 'fs_project', value: projectId, domain: 'localhost', path: '/' },
]);

const pages = [
  ['/app', 'dash.png'],
  ['/app/calendar', 'calendar.png'],
  ['/app/content', 'content.png'],
  ['/app/strategy', 'strategy.png'],
  ['/app/accounts', 'accounts.png'],
  ['/app/analytics', 'analytics.png'],
  ['/app/settings', 'settings.png'],
];

for (const [path, file] of pages) {
  try {
    await page.goto(`${base}${path}`, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${outDir}/${file}`, fullPage: true });
    console.log('captured', path, '→', file);
  } catch (e) {
    console.log('FAILED', path, String(e).slice(0, 140));
  }
}

// Mobile view of the Send Center.
const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  storageState: await ctx.storageState(),
});
const mp = await mobile.newPage();
await mp.goto(`${base}/app`, { waitUntil: 'networkidle', timeout: 45000 });
await mp.waitForTimeout(900);
await mp.screenshot({ path: `${outDir}/mobile.png`, fullPage: true });
console.log('captured /app (mobile) → mobile.png');

await browser.close();
console.log('project id:', projectId);
