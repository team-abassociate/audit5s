import type { AppLanguage } from './language';

/**
 * Every word the module picker shows (and, from step 5, the Kaizen screens), in English,
 * Hindi and Marathi — the same arrangement as `audit-strings.ts`. The module names stay as
 * the plant says them: "5S" is printed in Latin on every board, Kaizen is transliterated.
 */
export interface KaizenStrings {
  chooseWork: string;
  switchModule: string;
  fiveS: string;
  fiveSLine: string;
  kaizen: string;
  kaizenLine: string;
  auditsInProgress: (count: number) => string;
  nonconformitiesOwed: (count: number) => string;
  sentBack: (count: number) => string;
  drafts: (count: number) => string;
  awaitingReview: (count: number) => string;
  nothingWaiting: string;
  open: (module: string) => string;
}

const EN: KaizenStrings = {
  chooseWork: 'Choose work',
  switchModule: '⇄ Switch',
  fiveS: '5S Audit',
  fiveSLine: 'Audit your zone, close nonconformities',
  kaizen: 'Kaizen',
  kaizenLine: 'Record an improvement, before and after',
  auditsInProgress: (n) => (n === 1 ? 'audit in progress' : 'audits in progress'),
  nonconformitiesOwed: (n) => `${n} ${n === 1 ? 'nonconformity' : 'nonconformities'} owed`,
  sentBack: (n) => (n === 1 ? 'Kaizen sent back to you' : 'Kaizens sent back to you'),
  drafts: (n) => `${n} ${n === 1 ? 'draft' : 'drafts'} not submitted`,
  awaitingReview: () => 'awaiting your review',
  nothingWaiting: 'Nothing waiting on you',
  open: (module) => `Open ${module}`,
};

const HI: KaizenStrings = {
  chooseWork: 'काम चुनें',
  switchModule: '⇄ बदलें',
  fiveS: '5S ऑडिट',
  fiveSLine: 'अपने ज़ोन का ऑडिट करें, कमियाँ दूर करें',
  kaizen: 'काइज़ेन',
  kaizenLine: 'सुधार दर्ज करें, पहले और बाद में',
  auditsInProgress: (n) => (n === 1 ? 'ऑडिट चल रहा है' : 'ऑडिट चल रहे हैं'),
  nonconformitiesOwed: (n) => `${n} कमियाँ बाकी`,
  sentBack: () => 'काइज़ेन आपको वापस भेजे गए',
  drafts: (n) => `${n} ड्राफ़्ट जमा नहीं हुए`,
  awaitingReview: () => 'आपकी समीक्षा बाकी',
  nothingWaiting: 'आपके लिए कुछ बाकी नहीं',
  open: (module) => `${module} खोलें`,
};

const MR: KaizenStrings = {
  chooseWork: 'काम निवडा',
  switchModule: '⇄ बदला',
  fiveS: '5S ऑडिट',
  fiveSLine: 'तुमच्या झोनचे ऑडिट करा, त्रुटी दूर करा',
  kaizen: 'कायझेन',
  kaizenLine: 'सुधारणा नोंदवा, आधी आणि नंतर',
  auditsInProgress: (n) => (n === 1 ? 'ऑडिट सुरू आहे' : 'ऑडिट सुरू आहेत'),
  nonconformitiesOwed: (n) => `${n} त्रुटी बाकी`,
  sentBack: () => 'कायझेन तुम्हाला परत पाठवले',
  drafts: (n) => `${n} मसुदे सादर केलेले नाहीत`,
  awaitingReview: () => 'तुमच्या पुनरावलोकनाची वाट',
  nothingWaiting: 'तुमच्यासाठी काहीही बाकी नाही',
  open: (module) => `${module} उघडा`,
};

export const KAIZEN_STRINGS: Record<AppLanguage, KaizenStrings> = { en: EN, hi: HI, mr: MR };
