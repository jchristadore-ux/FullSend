import type { Metadata } from 'next';
import Link from 'next/link';
import { ContactLine, LegalPage, Points, Section } from '@/components/marketing/LegalPage';

export const metadata: Metadata = {
  title: 'Delete your data',
  description: 'Three ways to remove your data from FullSend, and exactly what each one deletes.',
};

/** Bumped by hand when the text changes, so it never claims to be today's. */
const UPDATED = '27 August 2026';

export default function DataDeletionPage() {
  return (
    <LegalPage
      title="Delete your data"
      updated={UPDATED}
      intro="Three ways to remove data from FullSend, in increasing order of finality. The first two are buttons you can press right now and they take effect immediately."
    >
      <Section heading="1. Disconnect a platform — removes its tokens">
        <p>
          In FullSend, go to <strong>Accounts</strong> and press <strong>Disconnect</strong> on the
          platform you want to cut off. Immediately, and without a grace period:
        </p>
        <Points>
          <li>
            The stored access and refresh tokens for that account are <strong>deleted</strong> from
            the database. FullSend can no longer post to it or read anything from it.
          </li>
          <li>
            Anything queued for that platform stops rather than retrying — it moves to
            &ldquo;needs approval&rdquo; so nothing goes out by surprise if you reconnect later.
          </li>
          <li>
            The account is marked disconnected. Its username, follower count and the record of what
            was already published stay, so your history and past metrics still make sense.
          </li>
        </Points>
        <p>
          You can also revoke FullSend from the platform&rsquo;s own settings — Instagram under{' '}
          <strong>Settings → Website permissions → Apps and websites</strong>, TikTok under{' '}
          <strong>Settings → Security → Manage app permissions</strong>. That cuts access at their
          end too, and is the belt-and-braces version.
        </p>
      </Section>

      <Section heading="2. Delete a project — removes everything about that product">
        <p>
          In <strong>Settings</strong>, delete the project. This cascades in a single database
          transaction and removes:
        </p>
        <Points>
          <li>The repository record and the product analysis built from it</li>
          <li>The strategy, personas, brand profile and content pillars</li>
          <li>Every content item, creative asset, and scheduled post</li>
          <li>The connected social accounts and their tokens</li>
          <li>Published post records and all collected analytics</li>
          <li>Jobs, automation runs, errors, notifications and reports for that project</li>
        </Points>
        <p>
          It does not delete posts already live on Instagram or TikTok. Those are on the platform,
          not here — delete them there.
        </p>
      </Section>

      <Section heading="3. Delete your account — removes everything">
        <p>
          To have your account and every project under it deleted, contact us and say so. We will
          confirm the request comes from the address on the account, delete it, and confirm when it
          is done. This covers your email address, your projects and all their contents, your audit
          log and your billing records.
        </p>
        <p>
          We action deletion requests within <strong>30 days</strong>, and in practice much sooner.
        </p>
        <ContactLine />
      </Section>

      <Section heading="What we cannot delete for you">
        <Points>
          <li>
            <strong>Live posts.</strong> Once something is published to Instagram or TikTok, it lives
            there under your account. Delete it on the platform.
          </li>
          <li>
            <strong>Data the platforms hold.</strong> Instagram and TikTok keep their own records of
            API activity under their own policies. Use their in-app data controls for that.
          </li>
          <li>
            <strong>Payment records.</strong> Where billing is enabled, Stripe retains transaction
            records for the period tax law requires, regardless of what we delete.
          </li>
        </Points>
      </Section>

      <Section heading="Related">
        <p>
          <Link href="/privacy">Privacy Policy</Link> — what is collected and how long it is kept.{' '}
          <Link href="/terms">Terms of Service</Link> — the agreement covering all of it.
        </p>
      </Section>
    </LegalPage>
  );
}
