import type {
  KaizenDashboardPeriod,
  KaizenFunnelStage,
  KaizenParameter,
  KaizenStatus,
  KaizenWaste,
} from '@audit5s/contracts';
import type { AppLanguage } from './language';

/**
 * Every word the module picker and the Kaizen screens show, in English, Hindi and Marathi —
 * the same arrangement as `audit-strings.ts`. The module names stay as the plant says them:
 * "5S" is printed in Latin on every board, Kaizen is transliterated. The sheet's own tool
 * names ([5W1H], [4M], [7 QC tools]) stay in Latin in every language, as the sheet prints them.
 */

/** The sheet's text fields, as the form and the detail label them. */
export type KaizenTextField =
  | 'machine'
  | 'lineArea'
  | 'implementedOn'
  | 'teamMembers'
  | 'theme'
  | 'target'
  | 'problem5w1h'
  | 'countermeasure'
  | 'benefits'
  | 'annualSaving'
  | 'rootCause4m'
  | 'analysis7qc'
  | 'ideaBy'
  | 'implementedBy';

/** The form's twelve steps, in the prototype's order. */
export const KAIZEN_STEPS = [
  'details',
  'team',
  'theme',
  'problem',
  'countermeasure',
  'before',
  'after',
  'wastes',
  'parameters',
  'horizontal',
  'benefits',
  'people',
] as const;
export type KaizenStep = (typeof KAIZEN_STEPS)[number];

export interface KaizenStrings {
  // picker
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

  // the card and the detail
  status: Record<KaizenStatus, string>;
  numberOnSync: string;
  before: string;
  after: string;
  none: string;
  photoOnline: string;
  fixAndResubmit: string;
  perYear: string;
  coordinator: string;
  editResubmit: string;
  continueDraft: string;
  notOnPhone: string;
  yes: string;
  no: string;

  // tabs and lists
  overview: string;
  newKaizen: string;
  history: string;
  last30Days: string;
  submitted: string;
  approved: string;
  pending: string;
  returned: string;
  newButton: string;
  returnedSection: string;
  draftsSection: string;
  awaitingSection: string;
  approvedSection: string;
  nothingReturned: string;
  noneApproved: string;
  historyEmpty: string;
  kaizenCount: (count: number) => string;

  // the form
  step: Record<KaizenStep, string>;
  field: Record<KaizenTextField, string>;
  zone: string;
  waste: Record<KaizenWaste, string>;
  parameter: Record<KaizenParameter, string>;
  horizontalQuestion: string;
  required: string;
  optional: string;
  done: string;
  next: string;
  submit: string;
  resubmit: string;
  takePhoto: string;
  retakePhoto: string;
  fromGallery: string;
  removePhoto: string;
  cameraPrompt: (kind: 'BEFORE' | 'AFTER') => string;
  fillThese: string;
  savedAsYouGo: string;
  noZone: string;
  badDate: string;
  badSaving: string;
  submittedNote: string;

  // the Coordinator (step 6)
  kaizens: string;
  myUnit: string;
  profile: string;
  analysis: string;
  all: string;
  period: Record<KaizenDashboardPeriod, string>;
  atAGlance: string;
  rejectionRatio: string;
  acceptanceRatio: string;
  funnelTitle: string;
  funnelStage: Record<KaizenFunnelStage, string>;
  ofSubmitted: (pct: string) => string;
  trendPrefix: string;
  trendSubmission: string;
  trendCompletion: string;
  trendSuffix: string;
  topTitle: string;
  noDepartment: string;
  noData: string;
  department: string;
  total: string;
  approvedSaving: string;
  reviewWaiting: (count: number) => string;
  top3Section: string;
  top3Empty: string;
  queueEmpty: string;
  needsConnection: string;
  reviewTitle: string;
  decision: Record<'APPROVED' | 'SENT_BACK' | 'REJECTED', string>;
  comment: string;
  reason: string;
  reasonRequired: string;
  confirm: (decision: string) => string;
  exportPdf: string;
  exporting: string;
  exportFailed: string;
  by: (name: string) => string;
}

const EN: KaizenStrings = {
  chooseWork: 'Choose work',
  switchModule: '⇄ Switch module',
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

  status: { DRAFT: 'Draft', SUBMITTED: 'Pending', APPROVED: 'Approved', SENT_BACK: 'Sent back', REJECTED: 'Rejected' },
  numberOnSync: 'Number on sync',
  before: 'Before',
  after: 'After',
  none: 'none',
  photoOnline: 'Shown online',
  fixAndResubmit: 'Fix and resubmit',
  perYear: 'a year',
  coordinator: 'Coordinator',
  editResubmit: 'Edit & resubmit',
  continueDraft: 'Continue draft',
  notOnPhone: 'This Kaizen is not on this phone.',
  yes: 'Yes',
  no: 'No',

  overview: 'Overview',
  newKaizen: 'New Kaizen',
  history: 'History',
  last30Days: 'Last 30 days',
  submitted: 'Submitted',
  approved: 'Approved',
  pending: 'Pending',
  returned: 'Returned',
  newButton: '+ New Kaizen',
  returnedSection: 'Sent back / rejected',
  draftsSection: 'Drafts',
  awaitingSection: 'Awaiting review',
  approvedSection: 'Approved · last 30 days',
  nothingReturned: 'Nothing returned by the Coordinator.',
  noneApproved: 'No approved Kaizens in the last 30 days.',
  historyEmpty: 'Your Kaizens will appear here.',
  kaizenCount: (n) => `${n} ${n === 1 ? 'Kaizen' : 'Kaizens'}`,

  step: {
    details: 'Kaizen details',
    team: 'Team members',
    theme: 'Kaizen theme',
    problem: 'Problem',
    countermeasure: 'Countermeasure',
    before: 'Before countermeasure',
    after: 'After countermeasure',
    wastes: 'Waste attacked',
    parameters: 'Parameters',
    horizontal: 'Horizontal deployment',
    benefits: 'Benefits / saving',
    people: 'Root cause & people',
  },
  field: {
    machine: 'Machine',
    lineArea: 'Line / area',
    implementedOn: 'Date of implementation (YYYY-MM-DD)',
    teamMembers: 'Names, comma separated',
    theme: 'Theme',
    target: 'Target & target date (optional)',
    problem5w1h: 'Problem [5W1H]',
    countermeasure: 'Countermeasure',
    benefits: 'Benefits, results and saving calculation',
    annualSaving: 'Annual cost saving, ₹ (optional)',
    rootCause4m: 'Root cause [4M]',
    analysis7qc: 'Analysis [7 QC tools] (optional)',
    ideaBy: 'Idea given by',
    implementedBy: 'Implemented by',
  },
  zone: 'Zone',
  waste: {
    DEFECTS: 'Defects',
    OVERPRODUCTION: 'Overproduction',
    WAITING_TIME: 'Waiting time',
    NON_UTILIZED_TALENT: 'Non-utilized talent',
    TRANSPORTATION: 'Transportation',
    INVENTORY: 'Inventory',
    MOTION: 'Motion',
    EXTRA_PROCESSING: 'Extra-processing',
  },
  parameter: {
    PRODUCTIVITY: 'Productivity',
    QUALITY: 'Quality',
    COST: 'Cost',
    DELIVERY: 'Delivery',
    SAFETY: 'Safety',
    MORALE: 'Morale',
  },
  horizontalQuestion: 'Can this be deployed on other machines or lines?',
  required: 'Required',
  optional: 'Optional',
  done: '✓ Done',
  next: 'Next',
  submit: 'Submit Kaizen',
  resubmit: 'Resubmit Kaizen',
  takePhoto: 'Take photo',
  retakePhoto: 'Retake photo',
  fromGallery: 'From gallery',
  removePhoto: 'Remove photo',
  cameraPrompt: (kind) => (kind === 'BEFORE' ? 'Photograph the condition before' : 'Photograph the condition after'),
  fillThese: 'Fill these before submitting',
  savedAsYouGo: 'Each field is saved on this phone as you go, and sent when there is signal.',
  noZone: 'No Zone of yours is on this phone yet. Sync, or ask your Coordinator.',
  badDate: 'Enter the date as YYYY-MM-DD.',
  badSaving: 'Enter the saving in rupees, digits only.',
  submittedNote: 'Submitted. It reaches your Coordinator when there is signal.',

  kaizens: 'Kaizens',
  myUnit: 'My Unit',
  profile: 'Profile',
  analysis: 'Analysis',
  all: 'All',
  period: { overall: 'Overall', year: 'Year', month: 'Month' },
  atAGlance: 'Kaizen at a glance',
  rejectionRatio: 'Rejection ratio',
  acceptanceRatio: 'Acceptance ratio',
  funnelTitle: 'Kaizen funnel',
  funnelStage: { SUBMITTED: 'Submitted', REVIEWED: 'Reviewed', APPROVED: 'Approved', APPROVED_WITH_SAVING: 'Approved with a saving' },
  ofSubmitted: (pct) => `${pct} of submitted`,
  trendPrefix: 'Kaizen',
  trendSubmission: 'Submission',
  trendCompletion: 'Completion',
  trendSuffix: 'trend',
  topTitle: 'Top 5 trend – Departments',
  noDepartment: 'No department',
  noData: 'No Kaizens submitted yet.',
  department: 'Department',
  total: 'Total',
  approvedSaving: 'Approved saving',
  reviewWaiting: (n) => `${n} ${n === 1 ? 'Kaizen waits' : 'Kaizens wait'} for your review`,
  top3Section: 'Top 3 approved by saving · last 30 days',
  top3Empty: 'No approved Kaizens in the last 30 days. Top 3 ranks them by annual saving.',
  queueEmpty: 'Nothing waiting for review.',
  needsConnection: 'These figures need a connection. Pull down to try again.',
  reviewTitle: 'Review',
  decision: { APPROVED: 'Approve', SENT_BACK: 'Send back', REJECTED: 'Reject' },
  comment: 'Comment (optional)',
  reason: 'Reason (required)',
  reasonRequired: 'A reason is required to send back or reject a Kaizen.',
  confirm: (decision) => `Confirm: ${decision}`,
  exportPdf: 'Download Kaizen Sheet (PDF)',
  exporting: 'Preparing the PDF…',
  exportFailed: 'The PDF could not be made. Try again.',
  by: (name) => `By ${name}`,
};

const HI: KaizenStrings = {
  chooseWork: 'काम चुनें',
  switchModule: '⇄ मॉड्यूल बदलें',
  fiveS: '5S ऑडिट',
  fiveSLine: 'अपने ज़ोन का ऑडिट करें, कमियाँ दूर करें',
  kaizen: 'काइज़ेन',
  kaizenLine: 'सुधार दर्ज करें, पहले और बाद में',
  auditsInProgress: (n) => (n === 1 ? 'ऑडिट चल रहा है' : 'ऑडिट चल रहे हैं'),
  nonconformitiesOwed: (n) => `${n} कमियाँ बाकी`,
  sentBack: () => 'काइज़ेन आपको वापस भेजे गए',
  drafts: (n) => `${n} मसौदे जमा नहीं हुए`,
  awaitingReview: () => 'आपकी समीक्षा बाकी',
  nothingWaiting: 'आपके लिए कुछ बाकी नहीं',
  open: (module) => `${module} खोलें`,

  status: { DRAFT: 'मसौदा', SUBMITTED: 'लंबित', APPROVED: 'स्वीकृत', SENT_BACK: 'वापस भेजा', REJECTED: 'अस्वीकृत' },
  numberOnSync: 'नंबर सिंक होने पर',
  before: 'पहले',
  after: 'बाद में',
  none: 'नहीं',
  photoOnline: 'ऑनलाइन दिखेगा',
  fixAndResubmit: 'सुधारें और फिर से जमा करें',
  perYear: 'प्रति वर्ष',
  coordinator: 'कोऑर्डिनेटर',
  editResubmit: 'सुधारें और फिर से जमा करें',
  continueDraft: 'मसौदा जारी रखें',
  notOnPhone: 'यह काइज़ेन इस फ़ोन पर नहीं है।',
  yes: 'हाँ',
  no: 'नहीं',

  overview: 'सारांश',
  newKaizen: 'नया काइज़ेन',
  history: 'इतिहास',
  last30Days: 'पिछले 30 दिन',
  submitted: 'जमा',
  approved: 'स्वीकृत',
  pending: 'लंबित',
  returned: 'लौटाए गए',
  newButton: '+ नया काइज़ेन',
  returnedSection: 'वापस भेजे / अस्वीकृत',
  draftsSection: 'मसौदे',
  awaitingSection: 'समीक्षा बाकी',
  approvedSection: 'स्वीकृत · पिछले 30 दिन',
  nothingReturned: 'कोऑर्डिनेटर ने कुछ वापस नहीं भेजा।',
  noneApproved: 'पिछले 30 दिनों में कोई काइज़ेन स्वीकृत नहीं हुआ।',
  historyEmpty: 'आपके काइज़ेन यहाँ दिखेंगे।',
  kaizenCount: (n) => `${n} काइज़ेन`,

  step: {
    details: 'काइज़ेन विवरण',
    team: 'टीम सदस्य',
    theme: 'काइज़ेन विषय',
    problem: 'समस्या',
    countermeasure: 'उपाय',
    before: 'उपाय से पहले',
    after: 'उपाय के बाद',
    wastes: 'कौन-सी बर्बादी घटी',
    parameters: 'मापदंड',
    horizontal: 'हॉरिज़ॉन्टल डिप्लॉयमेंट',
    benefits: 'लाभ / बचत',
    people: 'मूल कारण और लोग',
  },
  field: {
    machine: 'मशीन',
    lineArea: 'लाइन / क्षेत्र',
    implementedOn: 'लागू करने की तारीख (YYYY-MM-DD)',
    teamMembers: 'नाम, अल्पविराम से अलग',
    theme: 'विषय',
    target: 'लक्ष्य और लक्ष्य तारीख (वैकल्पिक)',
    problem5w1h: 'समस्या [5W1H]',
    countermeasure: 'उपाय',
    benefits: 'लाभ, परिणाम और बचत की गणना',
    annualSaving: 'वार्षिक बचत, ₹ (वैकल्पिक)',
    rootCause4m: 'मूल कारण [4M]',
    analysis7qc: 'विश्लेषण [7 QC tools] (वैकल्पिक)',
    ideaBy: 'विचार किसका था',
    implementedBy: 'किसने लागू किया',
  },
  zone: 'ज़ोन',
  waste: {
    DEFECTS: 'दोष',
    OVERPRODUCTION: 'अधिक उत्पादन',
    WAITING_TIME: 'प्रतीक्षा समय',
    NON_UTILIZED_TALENT: 'अप्रयुक्त प्रतिभा',
    TRANSPORTATION: 'परिवहन',
    INVENTORY: 'इन्वेंटरी',
    MOTION: 'गति',
    EXTRA_PROCESSING: 'अतिरिक्त प्रक्रिया',
  },
  parameter: {
    PRODUCTIVITY: 'उत्पादकता',
    QUALITY: 'गुणवत्ता',
    COST: 'लागत',
    DELIVERY: 'डिलीवरी',
    SAFETY: 'सुरक्षा',
    MORALE: 'मनोबल',
  },
  horizontalQuestion: 'क्या इसे दूसरी मशीनों या लाइनों पर लागू किया जा सकता है?',
  required: 'आवश्यक',
  optional: 'वैकल्पिक',
  done: '✓ पूरा',
  next: 'आगे',
  submit: 'काइज़ेन जमा करें',
  resubmit: 'फिर से जमा करें',
  takePhoto: 'फ़ोटो लें',
  retakePhoto: 'फिर से फ़ोटो लें',
  fromGallery: 'गैलरी से',
  removePhoto: 'फ़ोटो हटाएँ',
  cameraPrompt: (kind) => (kind === 'BEFORE' ? 'उपाय से पहले की स्थिति की फ़ोटो लें' : 'उपाय के बाद की स्थिति की फ़ोटो लें'),
  fillThese: 'जमा करने से पहले ये भरें',
  savedAsYouGo: 'हर जानकारी इसी फ़ोन पर तुरंत सहेजी जाती है और सिग्नल मिलने पर भेजी जाती है।',
  noZone: 'आपका कोई ज़ोन अभी इस फ़ोन पर नहीं है। सिंक करें, या कोऑर्डिनेटर से पूछें।',
  badDate: 'तारीख YYYY-MM-DD के रूप में लिखें।',
  badSaving: 'बचत रुपयों में लिखें, केवल अंक।',
  submittedNote: 'जमा हो गया। सिग्नल मिलने पर यह आपके कोऑर्डिनेटर तक पहुँचेगा।',

  kaizens: 'काइज़ेन',
  myUnit: 'मेरी यूनिट',
  profile: 'प्रोफ़ाइल',
  analysis: 'विश्लेषण',
  all: 'सभी',
  period: { overall: 'कुल', year: 'वर्ष', month: 'महीना' },
  atAGlance: 'काइज़ेन एक नज़र में',
  rejectionRatio: 'अस्वीकृति अनुपात',
  acceptanceRatio: 'स्वीकृति अनुपात',
  funnelTitle: 'काइज़ेन फ़नल',
  funnelStage: { SUBMITTED: 'जमा', REVIEWED: 'समीक्षित', APPROVED: 'स्वीकृत', APPROVED_WITH_SAVING: 'बचत सहित स्वीकृत' },
  ofSubmitted: (pct) => `जमा का ${pct}`,
  trendPrefix: 'काइज़ेन',
  trendSubmission: 'जमा',
  trendCompletion: 'पूर्णता',
  trendSuffix: 'ट्रेंड',
  topTitle: 'टॉप 5 ट्रेंड – विभाग',
  noDepartment: 'कोई विभाग नहीं',
  noData: 'अभी कोई काइज़ेन जमा नहीं हुआ।',
  department: 'विभाग',
  total: 'कुल',
  approvedSaving: 'स्वीकृत बचत',
  reviewWaiting: (n) => `${n} काइज़ेन आपकी समीक्षा की प्रतीक्षा में`,
  top3Section: 'बचत के अनुसार टॉप 3 स्वीकृत · पिछले 30 दिन',
  top3Empty: 'पिछले 30 दिनों में कोई काइज़ेन स्वीकृत नहीं हुआ। टॉप 3 वार्षिक बचत के क्रम में दिखते हैं।',
  queueEmpty: 'समीक्षा के लिए कुछ नहीं।',
  needsConnection: 'इन आँकड़ों के लिए इंटरनेट चाहिए। फिर से कोशिश के लिए नीचे खींचें।',
  reviewTitle: 'समीक्षा',
  decision: { APPROVED: 'स्वीकार करें', SENT_BACK: 'वापस भेजें', REJECTED: 'अस्वीकार करें' },
  comment: 'टिप्पणी (वैकल्पिक)',
  reason: 'कारण (आवश्यक)',
  reasonRequired: 'वापस भेजने या अस्वीकार करने के लिए कारण ज़रूरी है।',
  confirm: (decision) => `पुष्टि करें: ${decision}`,
  exportPdf: 'काइज़ेन शीट डाउनलोड करें (PDF)',
  exporting: 'PDF तैयार हो रहा है…',
  exportFailed: 'PDF नहीं बन सका। फिर से कोशिश करें।',
  by: (name) => `${name} द्वारा`,
};

const MR: KaizenStrings = {
  chooseWork: 'काम निवडा',
  switchModule: '⇄ मॉड्यूल बदला',
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

  status: { DRAFT: 'मसुदा', SUBMITTED: 'प्रलंबित', APPROVED: 'मंजूर', SENT_BACK: 'परत पाठवले', REJECTED: 'नाकारले' },
  numberOnSync: 'क्रमांक सिंकनंतर',
  before: 'आधी',
  after: 'नंतर',
  none: 'नाही',
  photoOnline: 'ऑनलाइन दिसेल',
  fixAndResubmit: 'दुरुस्त करा आणि पुन्हा सादर करा',
  perYear: 'दरवर्षी',
  coordinator: 'कोऑर्डिनेटर',
  editResubmit: 'दुरुस्त करा आणि पुन्हा सादर करा',
  continueDraft: 'मसुदा पुढे भरा',
  notOnPhone: 'हे कायझेन या फोनवर नाही.',
  yes: 'होय',
  no: 'नाही',

  overview: 'आढावा',
  newKaizen: 'नवीन कायझेन',
  history: 'इतिहास',
  last30Days: 'मागील 30 दिवस',
  submitted: 'सादर',
  approved: 'मंजूर',
  pending: 'प्रलंबित',
  returned: 'परत आलेले',
  newButton: '+ नवीन कायझेन',
  returnedSection: 'परत पाठवलेले / नाकारलेले',
  draftsSection: 'मसुदे',
  awaitingSection: 'पुनरावलोकन बाकी',
  approvedSection: 'मंजूर · मागील 30 दिवस',
  nothingReturned: 'कोऑर्डिनेटरने काहीही परत पाठवले नाही.',
  noneApproved: 'मागील 30 दिवसांत एकही कायझेन मंजूर झाले नाही.',
  historyEmpty: 'तुमचे कायझेन येथे दिसतील.',
  kaizenCount: (n) => `${n} कायझेन`,

  step: {
    details: 'कायझेन तपशील',
    team: 'टीम सदस्य',
    theme: 'कायझेन विषय',
    problem: 'समस्या',
    countermeasure: 'उपाय',
    before: 'उपायापूर्वी',
    after: 'उपायानंतर',
    wastes: 'कोणता अपव्यय कमी केला',
    parameters: 'निकष',
    horizontal: 'हॉरिझॉन्टल डिप्लॉयमेंट',
    benefits: 'फायदे / बचत',
    people: 'मूळ कारण आणि लोक',
  },
  field: {
    machine: 'मशीन',
    lineArea: 'लाइन / विभाग',
    implementedOn: 'अंमलबजावणीची तारीख (YYYY-MM-DD)',
    teamMembers: 'नावे, स्वल्पविरामाने वेगळी',
    theme: 'विषय',
    target: 'लक्ष्य आणि लक्ष्य तारीख (ऐच्छिक)',
    problem5w1h: 'समस्या [5W1H]',
    countermeasure: 'उपाय',
    benefits: 'फायदे, परिणाम आणि बचतीची गणना',
    annualSaving: 'वार्षिक बचत, ₹ (ऐच्छिक)',
    rootCause4m: 'मूळ कारण [4M]',
    analysis7qc: 'विश्लेषण [7 QC tools] (ऐच्छिक)',
    ideaBy: 'कल्पना कोणाची',
    implementedBy: 'अंमलबजावणी कोणी केली',
  },
  zone: 'झोन',
  waste: {
    DEFECTS: 'दोष',
    OVERPRODUCTION: 'अतिरिक्त उत्पादन',
    WAITING_TIME: 'प्रतीक्षा वेळ',
    NON_UTILIZED_TALENT: 'न वापरलेले कौशल्य',
    TRANSPORTATION: 'वाहतूक',
    INVENTORY: 'साठा',
    MOTION: 'हालचाल',
    EXTRA_PROCESSING: 'अतिरिक्त प्रक्रिया',
  },
  parameter: {
    PRODUCTIVITY: 'उत्पादकता',
    QUALITY: 'गुणवत्ता',
    COST: 'खर्च',
    DELIVERY: 'डिलिव्हरी',
    SAFETY: 'सुरक्षितता',
    MORALE: 'मनोबल',
  },
  horizontalQuestion: 'हे इतर मशीन किंवा लाइनवर लागू करता येईल का?',
  required: 'आवश्यक',
  optional: 'ऐच्छिक',
  done: '✓ पूर्ण',
  next: 'पुढे',
  submit: 'कायझेन सादर करा',
  resubmit: 'पुन्हा सादर करा',
  takePhoto: 'फोटो काढा',
  retakePhoto: 'पुन्हा फोटो काढा',
  fromGallery: 'गॅलरीतून',
  removePhoto: 'फोटो काढून टाका',
  cameraPrompt: (kind) => (kind === 'BEFORE' ? 'उपायापूर्वीच्या स्थितीचा फोटो काढा' : 'उपायानंतरच्या स्थितीचा फोटो काढा'),
  fillThese: 'सादर करण्यापूर्वी हे भरा',
  savedAsYouGo: 'प्रत्येक माहिती याच फोनवर लगेच जतन होते आणि सिग्नल मिळाल्यावर पाठवली जाते.',
  noZone: 'तुमचा कोणताही झोन अजून या फोनवर नाही. सिंक करा, किंवा कोऑर्डिनेटरला विचारा.',
  badDate: 'तारीख YYYY-MM-DD अशी लिहा.',
  badSaving: 'बचत रुपयांत लिहा, फक्त अंक.',
  submittedNote: 'सादर झाले. सिग्नल मिळाल्यावर ते तुमच्या कोऑर्डिनेटरकडे पोहोचेल.',

  kaizens: 'कायझेन',
  myUnit: 'माझे युनिट',
  profile: 'प्रोफाइल',
  analysis: 'विश्लेषण',
  all: 'सर्व',
  period: { overall: 'एकूण', year: 'वर्ष', month: 'महिना' },
  atAGlance: 'कायझेन एका दृष्टीक्षेपात',
  rejectionRatio: 'नाकारण्याचे प्रमाण',
  acceptanceRatio: 'मंजुरीचे प्रमाण',
  funnelTitle: 'कायझेन फनेल',
  funnelStage: { SUBMITTED: 'सादर', REVIEWED: 'पुनरावलोकन झाले', APPROVED: 'मंजूर', APPROVED_WITH_SAVING: 'बचतीसह मंजूर' },
  ofSubmitted: (pct) => `सादरपैकी ${pct}`,
  trendPrefix: 'कायझेन',
  trendSubmission: 'सादरीकरण',
  trendCompletion: 'पूर्णता',
  trendSuffix: 'ट्रेंड',
  topTitle: 'टॉप 5 ट्रेंड – विभाग',
  noDepartment: 'विभाग नाही',
  noData: 'अजून एकही कायझेन सादर झाले नाही.',
  department: 'विभाग',
  total: 'एकूण',
  approvedSaving: 'मंजूर बचत',
  reviewWaiting: (n) => `${n} कायझेन तुमच्या पुनरावलोकनाच्या प्रतीक्षेत`,
  top3Section: 'बचतीनुसार टॉप 3 मंजूर · मागील 30 दिवस',
  top3Empty: 'मागील 30 दिवसांत एकही कायझेन मंजूर झाले नाही. टॉप 3 वार्षिक बचतीनुसार दिसतात.',
  queueEmpty: 'पुनरावलोकनासाठी काहीही नाही.',
  needsConnection: 'या आकड्यांसाठी इंटरनेट लागते. पुन्हा प्रयत्नासाठी खाली ओढा.',
  reviewTitle: 'पुनरावलोकन',
  decision: { APPROVED: 'मंजूर करा', SENT_BACK: 'परत पाठवा', REJECTED: 'नाकारा' },
  comment: 'टिप्पणी (ऐच्छिक)',
  reason: 'कारण (आवश्यक)',
  reasonRequired: 'परत पाठवण्यासाठी किंवा नाकारण्यासाठी कारण आवश्यक आहे.',
  confirm: (decision) => `निश्चित करा: ${decision}`,
  exportPdf: 'कायझेन शीट डाउनलोड करा (PDF)',
  exporting: 'PDF तयार होत आहे…',
  exportFailed: 'PDF तयार झाले नाही. पुन्हा प्रयत्न करा.',
  by: (name) => `${name} यांनी`,
};

export const KAIZEN_STRINGS: Record<AppLanguage, KaizenStrings> = { en: EN, hi: HI, mr: MR };

/** A status's colour. Green is Approved and nothing else in Kaizen (owner, 2026-10-07). */
export const KAIZEN_STATUS_TONE: Record<KaizenStatus, 'ok' | 'warn' | 'crit' | 'muted'> = {
  DRAFT: 'muted',
  SUBMITTED: 'warn',
  APPROVED: 'ok',
  SENT_BACK: 'crit',
  REJECTED: 'crit',
};
