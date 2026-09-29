import type { TranslatedLanguage } from '@audit5s/contracts';

/**
 * Which language the questionnaire speaks — the whole of that decision, with no React and
 * no React Native in it, so it can be tested (the same split as `theme-choice.ts`).
 *
 * English is the record. The published question, the answer, the report and every
 * corrective action are English; Hindi and Marathi are how an auditor who reads them more
 * easily is shown the same question. So a translation never stands alone: the English is
 * shown beneath it, and a question nobody has translated is simply shown in English.
 */
export const APP_LANGUAGES = ['en', 'hi', 'mr'] as const;
export type AppLanguage = (typeof APP_LANGUAGES)[number];

/** Each language named in its own script, so a person finds theirs without reading English. */
export const LANGUAGE_NAMES: Record<AppLanguage, string> = {
  en: 'English',
  hi: 'हिन्दी',
  mr: 'मराठी',
};

/** The English name beside it, for whoever is helping someone else choose. */
export const LANGUAGE_ENGLISH_NAMES: Record<AppLanguage, string> = {
  en: 'English',
  hi: 'Hindi',
  mr: 'Marathi',
};

export const DEFAULT_LANGUAGE: AppLanguage = 'en';

export function isAppLanguage(value: unknown): value is AppLanguage {
  return APP_LANGUAGES.includes(value as AppLanguage);
}

/** A cached question's wording, as `listQuestionsWithAnswers` returns it. */
export interface QuestionWordingSource {
  text: string;
  textHi: string | null;
  textMr: string | null;
}

export interface QuestionWording {
  /** What the card leads with. */
  text: string;
  /** The English beneath it, or `null` when `text` already is the English. */
  english: string | null;
}

const COLUMN: Record<TranslatedLanguage, 'textHi' | 'textMr'> = { hi: 'textHi', mr: 'textMr' };

/**
 * The question in the chosen language, with the English kept beside it.
 *
 * A blank translation counts as none: showing an empty line above the English would read
 * as a question with nothing to answer.
 */
export function questionWording(
  question: QuestionWordingSource,
  language: AppLanguage,
): QuestionWording {
  if (language === 'en') return { text: question.text, english: null };
  const translated = question[COLUMN[language]]?.trim();
  return translated ? { text: translated, english: question.text } : { text: question.text, english: null };
}
