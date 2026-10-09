import { describe, expect, it } from 'vitest';
import { AUDIT_STRINGS } from './audit-strings';
import { KAIZEN_STRINGS } from './kaizen-strings';
import {
  APP_LANGUAGES,
  DEFAULT_LANGUAGE,
  isAppLanguage,
  questionWording,
  type QuestionWordingSource,
} from './language';

const QUESTION: QuestionWordingSource = {
  text: 'Tools are arranged on shadow boards / tool trolleys with outlines and labels.',
  textHi: 'औज़ार शैडो बोर्ड / टूल ट्रॉली पर आकृति (आउटलाइन) और लेबल के साथ व्यवस्थित रखे हैं।',
  textMr: 'टूल्स शॅडो बोर्ड / टूल ट्रॉलीवर बाह्यरेषा (आउटलाइन) आणि लेबलसह व्यवस्थित ठेवलेले आहेत.',
};

describe('the questionnaire language', () => {
  it('defaults to English, which is the record', () => {
    expect(DEFAULT_LANGUAGE).toBe('en');
  });

  it('recognises only the three languages it has', () => {
    expect(APP_LANGUAGES.every(isAppLanguage)).toBe(true);
    expect(isAppLanguage('gu')).toBe(false);
    expect(isAppLanguage(null)).toBe(false);
  });
});

describe('a question in the chosen language', () => {
  it('is the English alone when English is chosen', () => {
    expect(questionWording(QUESTION, 'en')).toEqual({ text: QUESTION.text, english: null });
  });

  it('leads with the translation and keeps the English beneath it', () => {
    expect(questionWording(QUESTION, 'hi')).toEqual({ text: QUESTION.textHi, english: QUESTION.text });
    expect(questionWording(QUESTION, 'mr')).toEqual({ text: QUESTION.textMr, english: QUESTION.text });
  });

  it('falls back to the English, once, when there is no translation', () => {
    const untranslated = { ...QUESTION, textHi: null, textMr: '   ' };
    expect(questionWording(untranslated, 'hi')).toEqual({ text: QUESTION.text, english: null });
    expect(questionWording(untranslated, 'mr')).toEqual({ text: QUESTION.text, english: null });
  });
});

describe('the questionnaire screen words', () => {
  const english = AUDIT_STRINGS.en;

  it('are complete in every language — no word falls through to blank', () => {
    for (const language of APP_LANGUAGES) {
      const strings = AUDIT_STRINGS[language];
      expect(Object.keys(strings).sort()).toEqual(Object.keys(english).sort());
      for (const [key, value] of Object.entries(strings)) {
        if (typeof value === 'string') expect(value.trim(), `${language}.${key}`).not.toBe('');
      }
    }
  });

  it('are written in Devanagari for Hindi and Marathi, not left in English', () => {
    for (const language of ['hi', 'mr'] as const) {
      const strings = AUDIT_STRINGS[language];
      expect(strings.submit).toMatch(/[ऀ-ॿ]/);
      expect(strings.remark).toMatch(/[ऀ-ॿ]/);
      expect(Object.values(strings.response).every((label) => /[ऀ-ॿ]/.test(label))).toBe(true);
      expect(strings.unanswered(3)).toContain('3');
    }
  });

  it('say exactly what the English screen said before languages existed', () => {
    expect(english.unanswered(1)).toBe('1 question still needs an answer. It is marked in red.');
    expect(english.unanswered(4)).toBe('4 questions still need an answer. They are marked in red.');
    expect(english.photoCount(1)).toBe('1 photo');
    expect(english.marksLine(34, 50, 20, 3)).toBe('34/50 marks\n20 answered, 3 NA');
  });
});

describe('the Kaizen strings', () => {
  it('give every language every word, and Hindi and Marathi in Devanagari', () => {
    // Every leaf, so a key added to English and forgotten elsewhere fails here.
    const leaves = (value: unknown, path: string): [string, string][] =>
      typeof value === 'string'
        ? [[path, value]]
        : typeof value === 'function'
          ? [[path, String((value as (n: number) => string)(2))]]
          : Object.entries(value as object).flatMap(([key, inner]) => leaves(inner, `${path}.${key}`));
    const english = leaves(KAIZEN_STRINGS.en, 'en').map(([path]) => path.slice(3));
    for (const language of ['hi', 'mr'] as const) {
      const strings = leaves(KAIZEN_STRINGS[language], language);
      expect(strings.map(([path]) => path.slice(3))).toEqual(english);
      for (const [path, value] of strings) expect(value.trim(), path).not.toBe('');
      expect(KAIZEN_STRINGS[language].submit).toMatch(/[ऀ-ॿ]/);
      expect(Object.values(KAIZEN_STRINGS[language].status).every((label) => /[ऀ-ॿ]/.test(label))).toBe(true);
    }
  });
});
