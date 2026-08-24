'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * One nav definition, two presentations: a rail on desktop and a bottom bar on
 * mobile. The mobile bar carries only what a founder checks from their phone.
 */

const ITEMS = [
  { href: '/app', label: 'Send Center', short: 'Home', icon: '◆', mobile: true },
  { href: '/app/calendar', label: 'Calendar', short: 'Calendar', icon: '▤', mobile: true },
  { href: '/app/content', label: 'Content', short: 'Content', icon: '▣', mobile: true },
  { href: '/app/analytics', label: 'Analytics', short: 'Stats', icon: '▲', mobile: true },
  { href: '/app/strategy', label: 'Strategy', short: 'Strategy', icon: '◈', mobile: false },
  { href: '/app/accounts', label: 'Accounts', short: 'Accounts', icon: '⬡', mobile: false },
  { href: '/app/settings', label: 'Settings', short: 'Settings', icon: '⚙', mobile: false },
];

export function AppNav({ variant }: { variant: 'rail' | 'bottom' }) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === '/app' ? pathname === '/app' : pathname.startsWith(href);

  if (variant === 'bottom') {
    const items = ITEMS.filter((i) => i.mobile);
    return (
      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-edge bg-void/95 backdrop-blur lg:hidden">
        {items.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={[
                'flex flex-col items-center gap-1 py-3 transition-colors',
                active ? 'text-orange' : 'text-dimmer',
              ].join(' ')}
            >
              <span className="text-base leading-none">{item.icon}</span>
              <span className="font-mono text-[10px] tracking-wide">{item.short}</span>
              {active && <span className="absolute top-0 h-0.5 w-10 bg-orange" />}
            </Link>
          );
        })}
      </nav>
    );
  }

  return (
    <nav className="flex-1 px-3 py-4">
      {ITEMS.map((item) => {
        const active = isActive(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={[
              'mb-0.5 flex items-center gap-3 rounded-sm px-3 py-2.5 text-sm transition-colors',
              active
                ? 'bg-orange/10 font-semibold text-orange'
                : 'text-dim hover:bg-charcoal hover:text-mist',
            ].join(' ')}
          >
            <span className="w-4 text-center text-xs">{item.icon}</span>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
