import type { ResponseValue, SSection } from '@audit5s/contracts';
import type { RatingBandToken } from '@audit5s/domain';
import type { AppLanguage } from './language';

/**
 * Every word the questionnaire screen shows, in English, Hindi and Marathi.
 *
 * Written for the screen, not translated word by word: "Remark" is the auditor's own note
 * (टिप्पणी / शेरा), the four answers say what an auditor would say aloud on the floor, and
 * the Japanese names of the five Ss stay as the plant prints them, with their meaning
 * beside. English here is exactly what the screen said before languages existed.
 *
 * Only this screen is translated. Reports, the admin web and the rest of the app stay
 * English, and so do the domain labels (`S_SECTION_LABELS`, `RESPONSE_TOKENS`) — the
 * report prints those, and a translation must never reach the record.
 */
export interface AuditStrings {
  questions: string;
  sectionTitle: Record<SSection, string>;
  questionRange: (from: number, to: number, total: number) => string;
  progress: (section: string) => string;
  answeredOnPage: (answered: number, total: number) => string;
  markingScheme: string;
  response: Record<ResponseValue, string>;
  schemeNote: string;
  responseMarks: string;
  answerRequired: string;
  photoCount: (count: number) => string;
  hideRemark: string;
  editRemark: string;
  addRemark: string;
  takePhoto: string;
  takePhotoFor: (question: number) => string;
  cameraPrompt: (question: number) => string;
  remark: string;
  remarkPlaceholder: string;
  previous: string;
  next: string;
  submit: string;
  saveChanges: string;
  done: string;
  close: string;
  unanswered: (count: number) => string;
  zonePhotos: (count: number, limit: number) => string;
  tooManyPhotos: (count: number, limit: number) => string;
  photoLimitReached: (limit: number) => string;
  deletePhotoHint: string;
  savesOffline: string;
  overallRemark: string;
  overallRemarkPlaceholder: string;
  /** R-38: the auditor's overall corrective-action suggestions for the Zone. */
  overallActions: string;
  overallActionsHint: string;
  overallActionPlaceholder: string;
  addOverallAction: string;
  removeOverallAction: string;
  scoreSoFar: string;
  scoreNote: string;
  marksLine: (raw: number, max: number, answered: number, na: number) => string;
  band: Record<RatingBandToken, string>;
  correctingTitle: string;
  correctingBody: string;
  doneCorrecting: string;
  finishedTitle: string;
  finishedBody: string;
  reasonLabel: string;
  reasonPlaceholder: string;
  reasonHint: string;
  correctMark: string;
  reviewingTitle: string;
  reviewingBody: string;
  notOnDevice: string;
  noChecklist: string;
  noAnswerToCorrect: string;
  pauseAudit: string;
  /** The stop on Next/Submit while this S has unanswered questions; numbers are Q numbers. */
  unansweredTitle: string;
  unansweredGate: (questions: readonly number[]) => string;
  ok: string;
}

const EN: AuditStrings = {
  questions: 'Questions',
  sectionTitle: {
    S1_SORT: '1S – SEIRI (SORT)',
    S2_SET_IN_ORDER: '2S – SEITON (SET IN ORDER)',
    S3_SHINE: '3S – SEISO (SHINE)',
    S4_STANDARDIZE: '4S – SEIKETSU (STANDARDIZE)',
    S5_SUSTAIN: '5S – SHITSUKE (SUSTAIN)',
  },
  questionRange: (from, to, total) => `Questions ${from}–${to} of ${total}`,
  progress: (section) => `${section} progress`,
  answeredOnPage: (answered, total) => `${answered} of ${total} answered on this page`,
  markingScheme: 'Marking scheme',
  response: {
    SCORE_2: 'Well implemented',
    SCORE_1: 'Progressing well',
    SCORE_0: 'Needs improvement',
    NA: 'Not applicable',
  },
  schemeNote: 'Every question is compulsory. Use NA only when the checkpoint does not apply here.',
  responseMarks: 'Response / marks',
  answerRequired: 'Answer required',
  photoCount: (count) => `${count} photo${count === 1 ? '' : 's'}`,
  hideRemark: 'Hide remark',
  editRemark: 'Edit remark',
  addRemark: 'Add remark',
  takePhoto: 'Take photo',
  takePhotoFor: (question) => `Take a photograph for question ${question}`,
  cameraPrompt: (question) => `Photograph for question ${question}`,
  remark: 'Remark',
  remarkPlaceholder: 'What you saw, in your words',
  previous: 'Previous',
  next: 'Next',
  submit: 'Submit',
  saveChanges: 'Save changes',
  done: 'Done',
  close: 'Close',
  unanswered: (count) =>
    `${count} question${count === 1 ? '' : 's'} still need${count === 1 ? 's' : ''} an answer. ${count === 1 ? 'It is' : 'They are'} marked in red.`,
  zonePhotos: (count, limit) => `${count} / ${limit} photos in this Zone — shared across all 50 questions.`,
  tooManyPhotos: (count, limit) =>
    `This Zone has ${count} photos. Remove ${count - limit} to meet the ${limit}-photo limit. Remove another to take a new photo.`,
  photoLimitReached: (limit) =>
    `This Zone has reached its ${limit}-photo limit. Remove a photo from this Zone before taking another.`,
  deletePhotoHint: 'Tap a photo below, then Delete photo. No photos are removed automatically.',
  savesOffline: 'Answers save on this device as you tap, and sync as soon as there is a connection.',
  overallRemark: 'Overall remark (optional)',
  overallRemarkPlaceholder: 'Anything the report should carry about this Zone',
  overallActions: 'Overall corrective action suggestions (optional)',
  overallActionsHint:
    'Things no photograph can show — a smell, a habit, a missing routine. Each one goes to the Zone leader with its own link in the report.',
  overallActionPlaceholder: 'e.g. Find the source of the oil smell and ventilate the bay',
  addOverallAction: 'Add corrective action',
  removeOverallAction: 'Remove',
  scoreSoFar: 'Score so far',
  scoreNote: 'Worked out on this device as a guide. The server recomputes it when the audit syncs.',
  marksLine: (raw, max, answered, na) => `${raw}/${max} marks\n${answered} answered, ${na} NA`,
  band: {
    'band-outstanding': 'Outstanding',
    'band-on-track': 'On Track',
    'band-improving': 'Improving',
    'band-needs-support': 'Needs Support',
  },
  correctingTitle: 'Correcting a finished audit',
  correctingBody:
    'Every mark you change is sent with your reason and written to the audit log, with what it was and what you made it (A-2). The score is recomputed for the dashboard and the report.',
  doneCorrecting: 'Done correcting',
  finishedTitle: 'This audit is finished',
  finishedBody:
    'The marks below are the record. You may still correct one you got wrong — it is logged with your reason, and nothing is overwritten quietly (A-2).',
  reasonLabel: 'Why the correction is needed',
  reasonPlaceholder: 'What was wrong with the mark, in your words',
  reasonHint: 'At least ten characters. It is written to the audit log.',
  correctMark: 'Correct a mark',
  reviewingTitle: 'Reviewing a finished Zone',
  reviewingBody:
    'Change any answer you need to, then press Submit again. The score is recomputed and the Zone counts as finished once more.',
  notOnDevice: 'This Zone is not on the device.',
  noChecklist: 'This Zone has no checklist pinned to it.',
  noAnswerToCorrect: 'This question has no saved answer to correct.',
  pauseAudit: 'Pause audit and go to Overview',
  unansweredTitle: 'Questions not answered',
  unansweredGate: (questions) =>
    `You have not answered question number${questions.length === 1 ? '' : 's'} ${questions.join(', ')}. Please answer all questions to proceed.`,
  ok: 'OK',
};

const HI: AuditStrings = {
  questions: 'प्रश्न',
  sectionTitle: {
    S1_SORT: '1S – SEIRI (छँटाई)',
    S2_SET_IN_ORDER: '2S – SEITON (व्यवस्थित रखना)',
    S3_SHINE: '3S – SEISO (सफ़ाई)',
    S4_STANDARDIZE: '4S – SEIKETSU (मानकीकरण)',
    S5_SUSTAIN: '5S – SHITSUKE (अनुशासन बनाए रखना)',
  },
  questionRange: (from, to, total) => `प्रश्न ${from}–${to} (कुल ${total})`,
  progress: (section) => `${section} प्रगति`,
  answeredOnPage: (answered, total) => `इस पेज के ${total} में से ${answered} प्रश्नों के उत्तर दिए गए`,
  markingScheme: 'अंक देने का तरीका',
  response: {
    SCORE_2: 'अच्छी तरह लागू है',
    SCORE_1: 'अच्छी प्रगति हो रही है',
    SCORE_0: 'सुधार की ज़रूरत है',
    NA: 'लागू नहीं',
  },
  schemeNote: 'हर प्रश्न का उत्तर देना ज़रूरी है। NA तभी चुनें जब यह जाँच-बिंदु यहाँ लागू ही न होता हो।',
  responseMarks: 'उत्तर / अंक',
  answerRequired: 'उत्तर देना ज़रूरी है',
  photoCount: (count) => `${count} फ़ोटो`,
  hideRemark: 'टिप्पणी छिपाएँ',
  editRemark: 'टिप्पणी बदलें',
  addRemark: 'टिप्पणी जोड़ें',
  takePhoto: 'फ़ोटो लें',
  takePhotoFor: (question) => `प्रश्न ${question} के लिए फ़ोटो लें`,
  cameraPrompt: (question) => `प्रश्न ${question} के लिए फ़ोटो`,
  remark: 'टिप्पणी',
  remarkPlaceholder: 'आपने क्या देखा, अपने शब्दों में',
  previous: 'पिछला',
  next: 'अगला',
  submit: 'जमा करें',
  saveChanges: 'बदलाव सेव करें',
  done: 'हो गया',
  close: 'बंद करें',
  unanswered: (count) =>
    count === 1
      ? '1 प्रश्न का उत्तर अभी बाक़ी है। उसे लाल रंग से दिखाया गया है।'
      : `${count} प्रश्नों के उत्तर अभी बाक़ी हैं। उन्हें लाल रंग से दिखाया गया है।`,
  zonePhotos: (count, limit) => `इस ज़ोन में ${count} / ${limit} फ़ोटो — सभी 50 प्रश्नों के लिए मिलाकर।`,
  tooManyPhotos: (count, limit) =>
    `इस ज़ोन में ${count} फ़ोटो हैं। ${limit} फ़ोटो की सीमा में आने के लिए ${count - limit} फ़ोटो हटाएँ। नई फ़ोटो लेने के लिए एक और हटाएँ।`,
  photoLimitReached: (limit) =>
    `इस ज़ोन में ${limit} फ़ोटो की सीमा पूरी हो गई है। नई फ़ोटो लेने से पहले इस ज़ोन की कोई फ़ोटो हटाएँ।`,
  deletePhotoHint: 'नीचे किसी फ़ोटो पर टैप करें, फिर Delete photo दबाएँ। कोई फ़ोटो अपने-आप नहीं हटाई जाती।',
  savesOffline: 'टैप करते ही उत्तर इस फ़ोन में सेव हो जाते हैं, और नेटवर्क मिलते ही सिंक हो जाते हैं।',
  overallRemark: 'पूरे ज़ोन पर टिप्पणी (वैकल्पिक)',
  overallRemarkPlaceholder: 'इस ज़ोन के बारे में जो बात रिपोर्ट में आनी चाहिए',
  overallActions: 'पूरे ज़ोन के लिए सुधारात्मक कार्रवाई के सुझाव (वैकल्पिक)',
  overallActionsHint:
    'जो बातें फ़ोटो में नहीं दिखतीं — जैसे बदबू, कोई आदत, कोई छूटा हुआ नियम। हर सुझाव रिपोर्ट में अपने लिंक के साथ ज़ोन लीडर तक जाएगा।',
  overallActionPlaceholder: 'जैसे: तेल की बदबू का स्रोत ढूँढें और हवा का इंतज़ाम करें',
  addOverallAction: 'सुधारात्मक कार्रवाई जोड़ें',
  removeOverallAction: 'हटाएँ',
  scoreSoFar: 'अब तक का स्कोर',
  scoreNote: 'यह स्कोर अंदाज़े के लिए इसी फ़ोन पर निकाला गया है। ऑडिट सिंक होने पर सर्वर इसे फिर से गिनता है।',
  marksLine: (raw, max, answered, na) => `${raw}/${max} अंक\n${answered} उत्तर दिए, ${na} NA`,
  band: {
    'band-outstanding': 'उत्कृष्ट',
    'band-on-track': 'सही दिशा में',
    'band-improving': 'सुधार हो रहा है',
    'band-needs-support': 'सहायता की ज़रूरत',
  },
  correctingTitle: 'पूरे हो चुके ऑडिट में सुधार',
  correctingBody:
    'आप जो भी अंक बदलते हैं, वह आपके कारण के साथ भेजा जाता है और ऑडिट लॉग में दर्ज होता है — पहले क्या था और आपने क्या किया (A-2)। डैशबोर्ड और रिपोर्ट के लिए स्कोर फिर से गिना जाता है।',
  doneCorrecting: 'सुधार पूरा हुआ',
  finishedTitle: 'यह ऑडिट पूरा हो चुका है',
  finishedBody:
    'नीचे दिए अंक ही रिकॉर्ड हैं। अगर कोई अंक ग़लत दिया गया है तो आप अब भी उसे सुधार सकते हैं — यह आपके कारण के साथ दर्ज होता है, चुपचाप कुछ नहीं बदला जाता (A-2)।',
  reasonLabel: 'सुधार की ज़रूरत क्यों है',
  reasonPlaceholder: 'अंक में क्या ग़लत था, अपने शब्दों में',
  reasonHint: 'कम से कम दस अक्षर। यह ऑडिट लॉग में दर्ज होता है।',
  correctMark: 'अंक सुधारें',
  reviewingTitle: 'पूरे हो चुके ज़ोन की समीक्षा',
  reviewingBody:
    'जो उत्तर बदलना हो बदलें, फिर दोबारा "जमा करें" दबाएँ। स्कोर फिर से गिना जाता है और ज़ोन फिर से पूरा माना जाता है।',
  notOnDevice: 'यह ज़ोन इस फ़ोन में नहीं है।',
  noChecklist: 'इस ज़ोन के साथ कोई चेकलिस्ट जुड़ी नहीं है।',
  noAnswerToCorrect: 'इस प्रश्न का कोई सेव किया हुआ उत्तर नहीं है जिसे सुधारा जा सके।',
  pauseAudit: 'ऑडिट रोकें और ओवरव्यू पर जाएँ',
  unansweredTitle: 'प्रश्नों के उत्तर बाक़ी हैं',
  unansweredGate: (questions) =>
    `आपने प्रश्न क्रमांक ${questions.join(', ')} का उत्तर नहीं दिया है। आगे बढ़ने के लिए सभी प्रश्नों के उत्तर दें।`,
  ok: 'ठीक है',
};

const MR: AuditStrings = {
  questions: 'प्रश्न',
  sectionTitle: {
    S1_SORT: '1S – SEIRI (वर्गीकरण)',
    S2_SET_IN_ORDER: '2S – SEITON (सुव्यवस्था)',
    S3_SHINE: '3S – SEISO (स्वच्छता)',
    S4_STANDARDIZE: '4S – SEIKETSU (प्रमाणीकरण)',
    S5_SUSTAIN: '5S – SHITSUKE (शिस्त टिकवणे)',
  },
  questionRange: (from, to, total) => `प्रश्न ${from}–${to} (एकूण ${total})`,
  progress: (section) => `${section} प्रगती`,
  answeredOnPage: (answered, total) => `या पानावरील ${total} पैकी ${answered} प्रश्नांची उत्तरे दिली`,
  markingScheme: 'गुणदान पद्धत',
  response: {
    SCORE_2: 'चांगल्या प्रकारे अंमलात आहे',
    SCORE_1: 'चांगली प्रगती होत आहे',
    SCORE_0: 'सुधारणा आवश्यक आहे',
    NA: 'लागू नाही',
  },
  schemeNote: 'प्रत्येक प्रश्नाचे उत्तर देणे आवश्यक आहे. हा तपासणी मुद्दा इथे लागूच होत नसेल तेव्हाच NA निवडा.',
  responseMarks: 'उत्तर / गुण',
  answerRequired: 'उत्तर देणे आवश्यक आहे',
  photoCount: (count) => `${count} फोटो`,
  hideRemark: 'शेरा लपवा',
  editRemark: 'शेरा बदला',
  addRemark: 'शेरा जोडा',
  takePhoto: 'फोटो घ्या',
  takePhotoFor: (question) => `प्रश्न ${question} साठी फोटो घ्या`,
  cameraPrompt: (question) => `प्रश्न ${question} साठी फोटो`,
  remark: 'शेरा',
  remarkPlaceholder: 'तुम्ही काय पाहिले, तुमच्या शब्दांत',
  previous: 'मागील',
  next: 'पुढील',
  submit: 'सबमिट करा',
  saveChanges: 'बदल जतन करा',
  done: 'झाले',
  close: 'बंद करा',
  unanswered: (count) =>
    count === 1
      ? '1 प्रश्नाचे उत्तर अजून बाकी आहे. तो लाल रंगात दाखवला आहे.'
      : `${count} प्रश्नांची उत्तरे अजून बाकी आहेत. ते लाल रंगात दाखवले आहेत.`,
  zonePhotos: (count, limit) => `या झोनमध्ये ${count} / ${limit} फोटो — सर्व 50 प्रश्नांसाठी मिळून.`,
  tooManyPhotos: (count, limit) =>
    `या झोनमध्ये ${count} फोटो आहेत. ${limit} फोटोंच्या मर्यादेत येण्यासाठी ${count - limit} फोटो काढा. नवीन फोटो घेण्यासाठी आणखी एक काढा.`,
  photoLimitReached: (limit) =>
    `या झोनमध्ये ${limit} फोटोंची मर्यादा पूर्ण झाली आहे. नवीन फोटो घेण्यापूर्वी या झोनमधील एखादा फोटो काढा.`,
  deletePhotoHint: 'खालील एखाद्या फोटोवर टॅप करा, मग Delete photo दाबा. कोणताही फोटो आपोआप काढला जात नाही.',
  savesOffline: 'टॅप करताच उत्तरे या फोनमध्ये जतन होतात आणि नेटवर्क मिळताच सिंक होतात.',
  overallRemark: 'संपूर्ण झोनबद्दल शेरा (ऐच्छिक)',
  overallRemarkPlaceholder: 'या झोनबद्दल अहवालात यावी अशी कोणतीही गोष्ट',
  overallActions: 'संपूर्ण झोनसाठी सुधारात्मक कृतीच्या सूचना (ऐच्छिक)',
  overallActionsHint:
    'ज्या गोष्टी फोटोत दिसत नाहीत — उदा. दुर्गंधी, एखादी सवय, राहून गेलेली पद्धत. प्रत्येक सूचना अहवालात स्वतःच्या लिंकसह झोन लीडरकडे जाईल.',
  overallActionPlaceholder: 'उदा. तेलाच्या वासाचा स्रोत शोधा आणि हवा खेळती ठेवा',
  addOverallAction: 'सुधारात्मक कृती जोडा',
  removeOverallAction: 'काढा',
  scoreSoFar: 'आतापर्यंतचा स्कोअर',
  scoreNote: 'हा स्कोअर अंदाजासाठी याच फोनवर काढलेला आहे. ऑडिट सिंक झाल्यावर सर्व्हर तो पुन्हा मोजतो.',
  marksLine: (raw, max, answered, na) => `${raw}/${max} गुण\n${answered} उत्तरे दिली, ${na} NA`,
  band: {
    'band-outstanding': 'उत्कृष्ट',
    'band-on-track': 'योग्य मार्गावर',
    'band-improving': 'सुधारणा होत आहे',
    'band-needs-support': 'मदतीची गरज',
  },
  correctingTitle: 'पूर्ण झालेल्या ऑडिटमध्ये दुरुस्ती',
  correctingBody:
    'तुम्ही बदललेला प्रत्येक गुण तुमच्या कारणासह पाठवला जातो आणि ऑडिट लॉगमध्ये नोंदवला जातो — आधी काय होते आणि तुम्ही काय केले (A-2). डॅशबोर्ड आणि अहवालासाठी स्कोअर पुन्हा मोजला जातो.',
  doneCorrecting: 'दुरुस्ती पूर्ण',
  finishedTitle: 'हे ऑडिट पूर्ण झाले आहे',
  finishedBody:
    'खालील गुण हीच नोंद आहे. एखादा गुण चुकीचा दिला असेल तर तुम्ही तो अजूनही दुरुस्त करू शकता — तो तुमच्या कारणासह नोंदवला जातो, काहीही गुपचूप बदलले जात नाही (A-2).',
  reasonLabel: 'दुरुस्ती का आवश्यक आहे',
  reasonPlaceholder: 'गुणात काय चुकले होते, तुमच्या शब्दांत',
  reasonHint: 'किमान दहा अक्षरे. हे ऑडिट लॉगमध्ये नोंदवले जाते.',
  correctMark: 'गुण दुरुस्त करा',
  reviewingTitle: 'पूर्ण झालेल्या झोनचा आढावा',
  reviewingBody:
    'जे उत्तर बदलायचे आहे ते बदला, मग पुन्हा "सबमिट करा" दाबा. स्कोअर पुन्हा मोजला जातो आणि झोन पुन्हा पूर्ण मानला जातो.',
  notOnDevice: 'हा झोन या फोनमध्ये नाही.',
  noChecklist: 'या झोनला कोणतीही चेकलिस्ट जोडलेली नाही.',
  noAnswerToCorrect: 'या प्रश्नाचे दुरुस्त करता येईल असे जतन केलेले उत्तर नाही.',
  pauseAudit: 'ऑडिट थांबवा आणि ओव्हरव्ह्यूवर जा',
  unansweredTitle: 'प्रश्नांची उत्तरे बाकी आहेत',
  unansweredGate: (questions) =>
    `तुम्ही प्रश्न क्रमांक ${questions.join(', ')} चे उत्तर दिलेले नाही. पुढे जाण्यासाठी सर्व प्रश्नांची उत्तरे द्या.`,
  ok: 'ठीक आहे',
};

export const AUDIT_STRINGS: Record<AppLanguage, AuditStrings> = { en: EN, hi: HI, mr: MR };
