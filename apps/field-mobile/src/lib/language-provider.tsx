import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AUDIT_STRINGS, type AuditStrings } from './audit-strings';
import { DEFAULT_LANGUAGE, type AppLanguage } from './language';
import { loadLanguage, saveLanguage } from './secure-storage';
import { useSession } from './session';

interface LanguageContextValue {
  language: AppLanguage;
  /** The questionnaire's words in `language`. */
  strings: AuditStrings;
  choose(next: AppLanguage): void;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

/**
 * The signed-in person's questionnaire language.
 *
 * It sits inside the session because the choice belongs to a person, not the phone: when
 * someone else signs in on a shared handset the language becomes theirs, and English until
 * their stored choice has been read. Writing is fire-and-forget, like the theme's.
 */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const userId = user?.id ?? null;
  const [language, setLanguage] = useState<AppLanguage>(DEFAULT_LANGUAGE);

  useEffect(() => {
    setLanguage(DEFAULT_LANGUAGE);
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      const stored = await loadLanguage(userId);
      if (!cancelled && stored) setLanguage(stored);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const choose = useCallback(
    (next: AppLanguage) => {
      setLanguage(next);
      if (userId) void saveLanguage(userId, next);
    },
    [userId],
  );

  const value = useMemo(
    () => ({ language, strings: AUDIT_STRINGS[language], choose }),
    [language, choose],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (!value) throw new Error('useLanguage must be used inside LanguageProvider');
  return value;
}
