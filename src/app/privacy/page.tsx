import type { Metadata } from 'next';
import Link from 'next/link';
import { ContactLine, DataTable, LegalPage, Points, Section } from '@/components/marketing/LegalPage';
import { legalEntity } from '@/lib/legal-contact';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    'What FullSend collects, where it goes, how long it is kept, and how to have it deleted.',
};

/** Bumped by hand when the text changes, so it never claims to be today's. */
const UPDATED = '27 August 2026';

export default function PrivacyPage() {
  const operator = legalEntity();

  return (
    <LegalPage
      title="Privacy Policy"
      updated={UPDATED}
      intro="FullSend connects to your code and to your social accounts, so it is worth being specific about what that means. This page lists every kind of data the service holds, who else sees it, and how to get rid of it."
    >
      <Section heading="1. Who runs this service">
        <p>
          This deployment of FullSend is operated by <strong>{operator}</strong> (&ldquo;we&rdquo;).
          FullSend is software you point at your own GitHub repository and your own social accounts;
          we process that data to run the service for you and for no other purpose.
        </p>
      </Section>

      <Section heading="2. What we collect, and why">
        <DataTable
          head={['Data', 'Where it comes from', 'Why we hold it']}
          rows={[
            [
              'Your email address',
              'You, when you sign in',
              'It is your account identifier and how we send you sign-in links and notifications.',
            ],
            [
              'Repository metadata and file contents',
              'The GitHub API, using access you grant',
              'To work out what your product does so the marketing is about the real thing.',
            ],
            [
              'Project settings — timezone, posting cap, autopilot mode, quiet hours',
              'You',
              'To schedule posts when you want them and stop when you say stop.',
            ],
            [
              'Generated content — hooks, captions, scripts, image and video briefs',
              'Produced by FullSend',
              'It is the product. You review, edit and approve it.',
            ],
            [
              'Social account profile — platform user ID, username, display name, avatar URL, follower count, granted scopes',
              'Instagram and TikTok, when you connect them',
              'To show you which account is connected and to publish to the right place.',
            ],
            [
              'Access and refresh tokens',
              'Instagram and TikTok OAuth',
              'To publish and read back metrics on your behalf. Stored encrypted — see section 7.',
            ],
            [
              'Published post IDs, permalinks and the platform’s response',
              'Instagram and TikTok, at publish time',
              'To link you to the live post and to fetch its metrics later.',
            ],
            [
              'Post and account metrics — views, likes, comments, shares, saves, reach, follower counts',
              'The Instagram and TikTok analytics APIs',
              'To measure what worked and adjust what gets posted next.',
            ],
            [
              'AI usage records — model, task, token counts and cost',
              'Produced by FullSend',
              'So you can see what the service is spending on your behalf and cap it.',
            ],
            [
              'Audit log — action, target, timestamp and IP address',
              'Produced by FullSend',
              'A record of who changed what, which matters when an account can post publicly.',
            ],
            [
              'Billing records — customer and subscription IDs, plan tier, period end',
              'Stripe, if billing is enabled on this deployment',
              'To run your subscription. We never see or store your card number.',
            ],
          ]}
        />
        <p>
          We do not collect analytics on your use of the FullSend interface, we do not run
          advertising or tracking pixels, and we do not sell or share any of the above with anyone
          outside the processors listed in section 5.
        </p>
      </Section>

      <Section heading="3. Data from Instagram and TikTok">
        <p>
          When you connect an account, the platform asks you to approve a specific set of
          permissions and shows you exactly what they cover. FullSend requests only what publishing
          and measurement need:
        </p>
        <Points>
          <li>
            <strong>Instagram</strong> — <code>instagram_business_basic</code> (your profile and
            media),
            <code> instagram_business_content_publish</code> (post on your behalf), and{' '}
            <code>instagram_business_manage_insights</code> (read the metrics on those posts).
          </li>
          <li>
            <strong>TikTok</strong> — <code>user.info.basic</code> (your profile),{' '}
            <code>video.publish</code> (post on your behalf), and <code>video.list</code> (read back
            what was posted and how it performed).
          </li>
        </Points>
        <p>
          We use platform data only to operate the features you connected it for. We do not use it
          to build advertising profiles, we do not combine it with data from other users, and we do
          not pass it to any third party other than the infrastructure processors in section 5.
        </p>
        <p>
          Revoking access on the platform&rsquo;s own settings page, or disconnecting inside
          FullSend, stops all of it — see <Link href="/data-deletion">Delete your data</Link>.
        </p>
      </Section>

      <Section heading="4. How AI is used">
        <p>
          FullSend sends your repository analysis, brand profile and content briefs to a large
          language model provider — Anthropic or OpenAI, depending on how this deployment is
          configured — to produce the drafts you review. That means:
        </p>
        <Points>
          <li>
            Text describing your product <strong>leaves our infrastructure</strong> and is processed
            by that provider under their API terms.
          </li>
          <li>
            We send it through the providers&rsquo; commercial APIs, which do not use API inputs to
            train their models by default.
          </li>
          <li>
            We never send your OAuth tokens, your email address, or your billing details to an AI
            provider.
          </li>
        </Points>
        <p>
          If your repository is private and you would rather its contents were not sent to a model
          provider, do not connect it. There is no version of this product that generates content
          about your app without reading your app.
        </p>
      </Section>

      <Section heading="5. Who else processes your data">
        <DataTable
          head={['Processor', 'What it handles']}
          rows={[
            ['Supabase', 'Database, authentication and file storage for generated creative.'],
            ['Vercel', 'Application hosting and request logs.'],
            [
              'Anthropic and/or OpenAI',
              'Content generation, as described in section 4.',
            ],
            ['GitHub', 'Source of the repository data you asked us to analyse.'],
            ['Meta (Instagram) and TikTok', 'Destinations you connected, for publishing and metrics.'],
            ['Stripe', 'Payment processing, if billing is enabled on this deployment.'],
          ]}
        />
        <p>
          Each of these is used for the function listed and nothing else. Where they store data
          depends on their own infrastructure; all of them operate internationally, so assume your
          data may be processed outside your own country.
        </p>
      </Section>

      <Section heading="6. How long we keep it">
        <Points>
          <li>
            <strong>OAuth tokens</strong> — deleted the moment you disconnect the account. Not kept
            for any grace period.
          </li>
          <li>
            <strong>Everything attached to a project</strong> — content, schedules, published post
            records, analytics, creative files — deleted when you delete the project. The database
            cascades it in one transaction.
          </li>
          <li>
            <strong>Your account and email</strong> — kept until you ask us to delete it.
          </li>
          <li>
            <strong>Audit and billing records</strong> — retained while the account is open, because
            they are the record of what was published and paid for.
          </li>
        </Points>
      </Section>

      <Section heading="7. Security">
        <Points>
          <li>
            Access and refresh tokens are encrypted with <strong>AES-256-GCM</strong> before they
            reach the database. No database policy grants any client read access to that table at
            all — the ciphertext is only ever decrypted in the process that is about to make a
            platform API call.
          </li>
          <li>
            Every other table is protected by row-level security keyed to your user ID, so one
            account cannot read another&rsquo;s rows even with a valid session.
          </li>
          <li>
            Background jobs run with elevated credentials, and the application applies the same
            per-user filter in that path rather than relying on the database alone.
          </li>
          <li>All traffic is served over HTTPS.</li>
        </Points>
        <p>
          No system is perfectly secure. If you find a vulnerability, please tell us before telling
          anyone else — see section 11.
        </p>
      </Section>

      <Section heading="8. Cookies">
        <p>
          FullSend sets one cookie: your sign-in session, issued by Supabase Auth when you click a
          magic link. It exists so you stay signed in. There are no advertising, analytics or
          third-party tracking cookies on this site.
        </p>
      </Section>

      <Section heading="9. Your rights">
        <p>
          You can ask us for a copy of what we hold about you, ask us to correct it, or ask us to
          delete it. Most of it you can do yourself, immediately, from inside the app — the{' '}
          <Link href="/data-deletion">Delete your data</Link> page explains which control does what.
          For anything you cannot do yourself, contact us and we will action it within 30 days.
        </p>
      </Section>

      <Section heading="10. Children">
        <p>
          FullSend is not intended for anyone under 16, and the platforms it publishes to set their
          own minimum ages. We do not knowingly collect data from children. If you believe a child
          has an account here, contact us and we will delete it.
        </p>
      </Section>

      <Section heading="11. Changes and contact">
        <p>
          If we change this policy in a way that affects what we do with your data, we will update
          the date at the top of this page and email account holders before the change takes effect.
        </p>
        <ContactLine />
      </Section>
    </LegalPage>
  );
}
