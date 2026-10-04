import type { PublicCorrectiveAction } from '@audit5s/contracts';

/**
 * Development only (`/ca/<variant>?data=worst`, read only under `import.meta.env.DEV`): the
 * worst a Zone Leader's phone can be handed by `GET /public/corrective-actions/{token}`, as a
 * `Response`, so the page's own status handling runs. The token names the variant:
 * `finding` (default), `overall`, `resubmit`, `closed`, `gone`, `error`.
 */

const LONG_QUESTION =
  'Are all tools, dies, jigs, fixtures, gauges and measuring instruments stored in their marked ' +
  'locations with shadow boards, labels and visual controls, and is every item that is not ' +
  'needed for the current shift removed from the workstation and red-tagged?';

const PORTRAIT_PHOTO = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1400"><rect width="600" height="1400" fill="gray"/><text x="40" y="700" font-size="48" fill="white">Tall portrait photo</text></svg>',
)}`;

const base: PublicCorrectiveAction = {
  correctiveActionId: '00000000-0000-7000-8000-000000000001',
  status: 'OPEN',
  unitName: 'Shree Venkateshwara Precision Forgings & Auto Components Pvt Ltd',
  zoneCode: 'Z-1284',
  zoneName: 'भंडार कक्ष (कच्चा माल) — पूर्वी गोदाम, हीट ट्रीटमेंट लाइन नंबर 3',
  auditDate: '2026-09-30T08:35:00.000Z',
  auditorName: 'Mr. Venkataraghavan Subramaniam-Iyengar & Mrs. Priyadarshini Ramachandran',
  questionGlobalOrder: 1284,
  questionText: LONG_QUESTION,
  section: 'S2_SET_IN_ORDER',
  findingRemark:
    'Oil spill under the press; drip tray missing; https://drive.example.com/very/long/unbroken/path/that/never/wraps/on/its/own/0123456789abcdef',
  suggestion: null,
  dueAt: '2026-10-07T18:29:00.000Z',
  beforePhotoUrl: PORTRAIT_PHOTO,
  submittable: true,
  issuedToName: 'Priyadarshini Venkataraghavan-Subramaniam Ramachandran-Iyengar',
  alreadySubmitted: null,
};

const VARIANTS: Record<string, PublicCorrectiveAction> = {
  finding: base,
  overall: {
    ...base,
    questionGlobalOrder: null,
    questionText: null,
    section: null,
    findingRemark: null,
    beforePhotoUrl: null,
    suggestion:
      'Fix the leaking drain in the heat-treatment pit, seal the floor joint, re-paint the walkway ' +
      'markings and set up a weekly 5-minute cleaning routine with a sign-off sheet at the entrance.',
  },
  resubmit: {
    ...base,
    status: 'REOPENED',
    beforePhotoUrl: null,
    issuedToName: null,
    alreadySubmitted: { option: 'COMPLETED', submittedAt: '2026-10-01T09:05:00.000Z' },
  },
  closed: {
    ...base,
    status: 'VERIFIED',
    submittable: false,
    alreadySubmitted: { option: 'NOT_POSSIBLE', submittedAt: '2026-10-01T09:05:00.000Z' },
  },
};

export function publicWorstCase(token: string): Response {
  if (token === 'gone') return new Response('{}', { status: 410 });
  if (token === 'error') {
    return new Response(JSON.stringify({ detail: 'The server is busy. Please try again in a minute.' }), {
      status: 503,
    });
  }
  return new Response(JSON.stringify(VARIANTS[token] ?? base), { status: 200 });
}
