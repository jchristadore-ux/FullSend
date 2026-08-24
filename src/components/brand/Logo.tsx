import { fullsendIconSvg, fullsendLockupSvg, type LogoTone } from '@/lib/brand/logo';

/**
 * The FullSend mark, rendered inline so it never flashes or depends on a
 * network fetch. Both forms come from the same generator as the exported
 * brand assets, so the app and the files in public/brand cannot drift.
 */

export function FullSendLockup({
  width = 168,
  tone = 'dark',
  className,
}: {
  width?: number;
  tone?: LogoTone;
  className?: string;
}) {
  return (
    <span
      className={className}
      aria-label="FullSend"
      role="img"
      dangerouslySetInnerHTML={{ __html: fullsendLockupSvg({ width, tone }) }}
    />
  );
}

export function FullSendIcon({
  size = 32,
  tone = 'dark',
  compact = true,
  className,
}: {
  size?: number;
  tone?: LogoTone;
  compact?: boolean;
  className?: string;
}) {
  return (
    <span
      className={className}
      aria-label="FullSend"
      role="img"
      dangerouslySetInnerHTML={{
        __html: fullsendIconSvg({ size, tone, compact, rounded: false }),
      }}
    />
  );
}
