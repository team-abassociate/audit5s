import { useEffect, useState } from 'react';

/**
 * Reads design-system token values out of the document.
 *
 * Recharts wants colours as strings, not classes, so this is the one sanctioned way to get
 * one (LEDGER.md rule 1: a component asks for a role, never a value). It re-reads when the
 * theme attribute or the device's colour scheme changes, so a chart repaints with the page.
 */
export function useToken(): (name: string) => string {
  const [, bump] = useState(0);

  useEffect(() => {
    const repaint = () => bump((n) => n + 1);
    const observer = new MutationObserver(repaint);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', repaint);
    return () => {
      observer.disconnect();
      scheme.removeEventListener('change', repaint);
    };
  }, []);

  return (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
