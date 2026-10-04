import type {
  ChecklistTemplate,
  ChecklistVersion,
  ChecklistVersionDetail,
  Industry,
  Page,
} from '@audit5s/contracts';
import { QUESTIONS_PER_SECTION, S_SECTION_ORDER } from '@audit5s/domain';

/** Dev-only worst case for Checklists and Industries (`?data=worst`, break-ui). */
export const isWorstCase = () =>
  import.meta.env.DEV && new URLSearchParams(window.location.search).get('data') === 'worst';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = '2026-09-30T09:05:00.000Z';
const LONG_INDUSTRY = 'Automotive Precision Forgings & Heavy Fabrication (Tier-1 Suppliers)';
const HINDI_INDUSTRY = 'अस्पताल एवं स्वास्थ्य सेवाएँ';

const industry = (n: number, name: string, code: string, templates: number, units: number, archived = false): Industry => ({
  id: uuid(n),
  code,
  name,
  description: null,
  sortOrder: n,
  archivedAt: archived ? AT : null,
  createdAt: AT,
  updatedAt: AT,
  templateCount: templates,
  unitCount: units,
});

export const worstIndustries = (includeArchived: boolean): Industry[] =>
  [
    industry(1, LONG_INDUSTRY, 'AUTOMOTIVE_PRECISION_FORGINGS_HEAVY_FAB', 1284, 1284),
    industry(2, HINDI_INDUSTRY, 'HOSPITAL', 1, 1),
    industry(3, 'IT', 'IT', 0, 0),
    industry(4, 'Food & Beverage Processing (Cold Chain)', 'FOOD_BEVERAGE', 9, 0, true),
  ].filter((row) => includeArchived || row.archivedAt === null);

const TEMPLATE_NAMES = [
  'Stores (RM) — Raw Material Receiving, Inspection & Quarantine Bay',
  'QA',
  'मशीन शॉप (CNC / VMC)',
  'Press Shop 250T–800T Mechanical & Hydraulic Lines',
];

export function worstTemplates(): Page<ChecklistTemplate> {
  const data = Array.from({ length: 40 }, (_, i): ChecklistTemplate => ({
    id: uuid(100 + i),
    code: i === 0 ? 'STORES_RM_RAW_MATERIAL_RECEIVING_INSPECTION_QUARANTINE' : `DEPT_${i}`,
    name: TEMPLATE_NAMES[i % TEMPLATE_NAMES.length]!,
    description: null,
    isActive: true,
    industries:
      i % 4 === 0
        ? [1, 2, 3].map((n) => ({ id: uuid(n), name: [LONG_INDUSTRY, HINDI_INDUSTRY, 'IT'][n - 1]! }))
        : i % 4 === 1
          ? []
          : [{ id: uuid(2), name: HINDI_INDUSTRY }],
    sortOrder: i,
    archivedAt: null,
    createdAt: AT,
    updatedAt: AT,
    publishedVersionId: i % 4 === 3 ? null : uuid(500 + i),
    publishedVersionNumber: i % 4 === 3 ? null : i === 0 ? 1284 : 1,
  }));
  return { data, nextCursor: null };
}

const version = (n: number, status: ChecklistVersion['status']): ChecklistVersion => ({
  id: uuid(500 + n),
  templateId: uuid(100),
  templateCode: 'DEPT',
  templateName: TEMPLATE_NAMES[0]!,
  versionNumber: n,
  status,
  questionsPerSection: QUESTIONS_PER_SECTION,
  totalQuestions: 50,
  publishedAt: status === 'DRAFT' ? null : AT,
  publishedByUserId: null,
  supersededAt: null,
  supersededByVersionId: null,
  sourceImportJobId: null,
  contentHash: '0'.repeat(64),
  createdAt: AT,
});

export const worstVersions = (): Page<ChecklistVersion> => ({
  data: [version(1284, 'DRAFT'), version(1283, 'PUBLISHED'), version(1, 'SUPERSEDED')],
  nextCursor: null,
});

const LONG_EN =
  'Are all raw-material bins, pallets and quarantine racks labelled with part number, heat number, supplier lot and FIFO date, with no unlabelled or mixed stock anywhere in the bay?';
const LONG_HI =
  'क्या सभी कच्चे माल के डिब्बे, पैलेट और क्वारंटाइन रैक पर पार्ट नंबर, हीट नंबर, आपूर्तिकर्ता लॉट और फीफो तिथि लिखी है, और कहीं भी बिना लेबल या मिला हुआ माल नहीं है?';
const LONG_MR =
  'सर्व कच्च्या मालाचे डबे, पॅलेट आणि क्वारंटाईन रॅकवर पार्ट नंबर, हीट नंबर, पुरवठादार लॉट आणि फिफो तारीख लिहिलेली आहे का, आणि कुठेही लेबल नसलेला किंवा मिसळलेला माल नाही का?';

export function worstVersionDetail(id: string): ChecklistVersionDetail {
  return {
    ...version(1283, 'PUBLISHED'),
    id,
    questions: S_SECTION_ORDER.flatMap((section, s) =>
      Array.from({ length: QUESTIONS_PER_SECTION }, (_, q) => {
        const n = s * QUESTIONS_PER_SECTION + q;
        return {
          id: uuid(1000 + n),
          versionId: id,
          section,
          orderInSection: q + 1,
          globalOrder: n + 1,
          text: n % 3 === 0 ? LONG_EN : 'Floor clean?',
          guidance: null,
          allowsNa: true,
          requiresEvidenceOnNonconformity: false,
          translations: n % 3 === 0 ? { hi: LONG_HI, mr: LONG_MR } : n % 3 === 1 ? { hi: 'फर्श साफ़?' } : {},
        };
      }),
    ),
  };
}
