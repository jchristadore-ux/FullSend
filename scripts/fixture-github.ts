/**
 * A local stand-in for api.github.com.
 *
 * Serves the exact REST shapes FullSend's GitHub client consumes for one
 * repository, so the real client, the real ingestion and the real analysis path
 * can be exercised end to end without network access to GitHub.
 *
 * Point the app at it with GITHUB_API_BASE=http://localhost:3210
 */
import http from 'node:http';

const OWNER = process.env.FIXTURE_OWNER ?? 'acme';
const REPO = process.env.FIXTURE_REPO ?? 'taskflow';
const PORT = Number(process.env.FIXTURE_PORT ?? 3210);

const README = `# Taskflow

Turn messy team chatter into a clean task list, automatically.

Taskflow watches the channels your team already uses, pulls out the things
someone actually committed to, and puts them somewhere you will look.

## Automatic task extraction
Reads messages and identifies real commitments, not every sentence with a verb.

## Smart prioritisation
Ranks by deadline pressure and by how many people are blocked on each item.

## Daily digest
One message every morning with what matters today. Nothing else.

## Slack and Linear sync
Two-way sync so a task closed in Linear disappears from the digest.

## Installation
\`\`\`
npm install && npm run dev
\`\`\`

![Inbox screenshot](docs/screenshot-inbox.png)
![Digest screenshot](docs/screenshot-digest.png)
`;

const PACKAGE_JSON = JSON.stringify(
  {
    name: 'taskflow',
    version: '1.4.0',
    dependencies: {
      next: '15.0.0',
      react: '19.0.0',
      '@anthropic-ai/sdk': '0.30.0',
      '@supabase/supabase-js': '2.45.0',
      tailwindcss: '3.4.0',
      stripe: '16.0.0',
    },
    devDependencies: { typescript: '5.6.0', vitest: '2.0.0' },
    scripts: { dev: 'next dev', build: 'next build', test: 'vitest', cli: 'node bin/cli.js' },
  },
  null,
  2,
);

const SOURCES: Record<string, string> = {
  'src/app/page.tsx': `export default function Home() {
  return (<main>
    <h1>Taskflow</h1>
    <h2>Stop losing what your team agreed to</h2>
    <button>Connect your workspace</button>
    <button>See a sample digest</button>
  </main>);
}`,
  'src/app/inbox/page.tsx': `export default function Inbox() {
  return (<main>
    <h1>Inbox</h1>
    <h2>Extracted today</h2>
    <button aria-label="Extract tasks">Extract tasks</button>
    <button>Mark done</button>
    <input placeholder="Filter by person" />
  </main>);
}`,
  'src/app/digest/page.tsx': `export default function Digest() {
  return (<main>
    <h1>Daily digest</h1>
    <h2>What matters today</h2>
    <button>Send now</button>
    <button>Change delivery time</button>
  </main>);
}`,
  'src/app/settings/page.tsx': `export default function Settings() {
  return (<main><h1>Settings</h1><button>Connect Linear</button></main>);
}`,
};

const TREE = [
  { path: 'package.json', size: PACKAGE_JSON.length },
  { path: 'README.md', size: README.length },
  ...Object.entries(SOURCES).map(([path, src]) => ({ path, size: src.length })),
  { path: 'docs/screenshot-inbox.png', size: 284_000 },
  { path: 'docs/screenshot-digest.png', size: 196_000 },
  { path: 'tests/extract.test.ts', size: 4200 },
  { path: 'tests/priority.test.ts', size: 3100 },
  { path: '.github/workflows/ci.yml', size: 900 },
  ...Array.from({ length: 64 }, (_, i) => ({ path: `src/lib/module-${i}.ts`, size: 1500 })),
];

function json(res: http.ServerResponse, body: unknown, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'x-ratelimit-remaining': '4999',
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const p = url.pathname;
  const base = `/repos/${OWNER}/${REPO}`;

  if (p === base) {
    return json(res, {
      owner: { login: OWNER },
      name: REPO,
      full_name: `${OWNER}/${REPO}`,
      html_url: `https://github.com/${OWNER}/${REPO}`,
      description: 'Turn messy team chatter into a clean task list, automatically.',
      default_branch: 'main',
      language: 'TypeScript',
      topics: ['productivity', 'tasks', 'slack', 'ai'],
      stargazers_count: 842,
      private: false,
      size: 4200,
      pushed_at: new Date().toISOString(),
      homepage: 'https://taskflow.example.com',
      license: { spdx_id: 'MIT' },
    });
  }

  if (p === `${base}/languages`) {
    return json(res, { TypeScript: 184_000, CSS: 12_400, JavaScript: 6_100 });
  }

  if (p.startsWith(`${base}/git/trees/`)) {
    return json(res, {
      sha: 'fixture',
      truncated: false,
      tree: TREE.map((t) => ({ path: t.path, type: 'blob', size: t.size })),
    });
  }

  if (p === `${base}/readme`) {
    return json(res, {
      name: 'README.md',
      path: 'README.md',
      size: README.length,
      encoding: 'base64',
      content: Buffer.from(README, 'utf8').toString('base64'),
    });
  }

  if (p.startsWith(`${base}/contents/`)) {
    const file = decodeURIComponent(p.slice(`${base}/contents/`.length));
    const content = file === 'package.json' ? PACKAGE_JSON : SOURCES[file];
    if (content === undefined) return json(res, { message: 'Not Found' }, 404);
    return json(res, {
      name: file.split('/').pop(),
      path: file,
      size: content.length,
      encoding: 'base64',
      content: Buffer.from(content, 'utf8').toString('base64'),
    });
  }

  if (p === '/user') return json(res, { login: 'fixture-user', avatar_url: '' });

  return json(res, { message: 'Not Found' }, 404);
});

server.listen(PORT, () => {
  console.log(`GitHub fixture serving ${OWNER}/${REPO} on http://localhost:${PORT}`);
});
