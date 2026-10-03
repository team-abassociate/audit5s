import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AUDIT_STATUSES,
  ASSIGNMENT_STATUSES,
  AUDIT_ZONE_STATUSES,
  CHECKLIST_VERSION_STATUSES,
  CORRECTIVE_ACTION_STATUSES,
  USER_STATUSES,
} from '@audit5s/contracts';
import {
  BandLabel,
  Button,
  ConfirmDialog,
  Dialog,
  DialogActions,
  EmptyState,
  Field,
  Input,
  RowActions,
  SidePanel,
  Skeleton,
  Slip,
  StatusChip,
  Table,
  Td,
  Th,
  useDialogClose,
  useRoutedPanel,
} from '@/components/ui';
import type { StatusShape } from '@/components/ui';

/**
 * Every shared component, in every state, in whichever theme is stamped (UX audit S4, step 3).
 * Development only (see `route.ts`). "Worst case" swaps in long and non-Latin names.
 */

interface DemoZone {
  id: string;
  name: string;
  leader: string;
  score: number | null;
}

const ZONES: DemoZone[] = [
  { id: 'z7', name: 'Zone 7 · Press shop', leader: 'Aniket Bagde', score: 91.2 },
  { id: 'z8', name: 'Zone 8 · Stores (RM)', leader: 'Priya Nair', score: 78.5 },
  { id: 'z9', name: 'Zone 9 · Packing area', leader: 'R. Deshmukh', score: 64.0 },
  { id: 'z10', name: 'Zone 10 · Boiler & utility', leader: '—', score: null },
];

const WORST: DemoZone[] = [
  {
    id: 'z7',
    name: 'Zone 17 · Boiler & Utility — effluent treatment plant, north annexe, second floor mezzanine',
    leader: 'Venkatanarasimharajuvaripeta Subrahmanyam Lakshminarayana',
    score: 100,
  },
  { id: 'z8', name: 'ज़ोन 8 · भंडार (कच्चा माल)', leader: 'प्रिया नायर', score: 0 },
  { id: 'z9', name: 'Z', leader: 'A', score: 59.99 },
  { id: 'z10', name: 'zone.with.an.unbreakable.identifier.that.never.ends@example-plant.in', leader: '—', score: null },
];

function applyTheme(mode: 'light' | 'dark') {
  document.documentElement.setAttribute('data-theme', mode);
  try {
    localStorage.setItem('gemba-theme', mode);
  } catch {
    // Not remembered; the page still switches.
  }
}

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export function ComponentGallery() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
  );
  const [worst, setWorst] = useState(false);
  const zones = worst ? WORST : ZONES;

  return (
    <main className="gb-gallery">
      <header className="gb-gallery-head">
        <div>
          <h1 className="gb-h1">Components</h1>
          <p className="gb-hint">Development only. Every shared component, in every state.</p>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Theme and data">
          {(['light', 'dark'] as const).map((mode) => (
            <Button
              key={mode}
              variant="secondary"
              aria-pressed={theme === mode}
              onClick={() => {
                applyTheme(mode);
                setTheme(mode);
              }}
            >
              {mode === 'light' ? 'Light' : 'Dark'}
            </Button>
          ))}
          <Button variant="secondary" aria-pressed={worst} onClick={() => setWorst((on) => !on)}>
            Worst case
          </Button>
        </div>
      </header>

      <Section title="StatusChip" note="Ink and a shape; never a band colour (G12).">
        <ChipRow label="Audit" items={AUDIT_STATUSES.map((s) => <StatusChip key={s} kind="audit" status={s} />)} />
        <ChipRow label="Zone of an audit" items={AUDIT_ZONE_STATUSES.map((s) => <StatusChip key={s} kind="zone" status={s} />)} />
        <ChipRow label="Assignment" items={ASSIGNMENT_STATUSES.map((s) => <StatusChip key={s} kind="assignment" status={s} />)} />
        <ChipRow label="Corrective action" items={CORRECTIVE_ACTION_STATUSES.map((s) => <StatusChip key={s} kind="action" status={s} />)} />
        <ChipRow label="Checklist version" items={CHECKLIST_VERSION_STATUSES.map((s) => <StatusChip key={s} kind="checklist" status={s} />)} />
        <ChipRow label="User" items={USER_STATUSES.map((s) => <StatusChip key={s} kind="user" status={s} />)} />
        <ChipRow
          label="Free shape"
          items={(['open', 'progress', 'paused', 'done', 'attention', 'ended', 'active'] as StatusShape[]).map((shape) => (
            <StatusChip key={shape} shape={shape}>
              {shape}
            </StatusChip>
          ))}
        />
      </Section>

      <Section title="BandLabel" note="Word, colour and shape; N/A is not a band (B2).">
        <ChipRow
          label="Scores"
          items={[96.4, 89.99, 75, 74.99, 60, 41.2, 0, null].map((score) => (
            <span key={String(score)} className="inline-flex items-center gap-2">
              <span className="gb-data text-ink-2">{score === null ? '—' : score.toFixed(2)}</span>
              <BandLabel score={score} />
            </span>
          ))}
        />
      </Section>

      <Section title="Dialog" note="Native <dialog>: label above field, actions right, secondary then primary.">
        <DialogDemos subject={zones[0]!.name} />
      </Section>

      <Section title="RowActions in a register table" note="One safe action in sight; destructive items confirm, naming the object (G6). Fixed columns (U9, I4, L7).">
        <RegisterDemo zones={zones} />
      </Section>

      <Section title="SidePanel" note="Routed: ?panel=<id>. Back closes it. Full-width sheet under 1180px.">
        <PanelDemo zones={zones} />
      </Section>

      <Section title="Skeleton" note="While loading only — never as an empty state (B8).">
        <div className="grid gap-4">
          <Skeleton variant="tiles" count={4} label="Loading the board…" />
          <Skeleton variant="rows" columns={['Zone', 'Leader', 'Score', '']} rows={3} label="Loading Zones…" />
          <Skeleton variant="chart" label="Loading the trend…" />
        </div>
      </Section>

      <Section title="EmptyState" note="The fact, then the way out (CA5, I3).">
        <div className="grid gap-3">
          <EmptyState title="No archived industries." />
          <EmptyState
            title="No corrective actions match these filters."
            action={<Button variant="secondary">Clear filters</Button>}
          >
            {worst
              ? 'Status: Reopened · Zone: Zone 17 · Boiler & Utility — effluent treatment plant, north annexe · Leader: Venkatanarasimharajuvaripeta Subrahmanyam'
              : 'Status: Reopened · Zone: Zone 7'}
          </EmptyState>
        </div>
      </Section>

      <Section title="Slip" note="One per view; slides down 8px in 180ms.">
        <SlipDemo subject={zones[0]!.name} />
      </Section>
    </main>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section className="gb-gallery-section" aria-labelledby={`gallery-${title}`}>
      <h2 id={`gallery-${title}`} className="gb-h2">
        {title}
      </h2>
      <p className="gb-hint">{note}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function ChipRow({ label, items }: { label: string; items: ReactNode[] }) {
  return (
    <div className="gb-gallery-row">
      <span className="gb-label">{label}</span>
      <div className="flex flex-wrap items-center gap-2">{items}</div>
    </div>
  );
}

function DialogDemos({ subject }: { subject: string }) {
  const [form, setForm] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [wide, setWide] = useState(false);
  const [confirm, setConfirm] = useState<'idle' | 'open' | 'pending' | 'failed'>('idle');
  const failedOnce = useRef(false);

  const closeForm = () => {
    setForm(false);
    setName('');
    setCode('');
  };

  return (
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => setForm(true)}>New industry</Button>
      <Button variant="secondary" onClick={() => setWide(true)}>
        Wide dialog
      </Button>
      <Button variant="danger" onClick={() => setConfirm('open')}>
        Archive…
      </Button>

      <Dialog
        open={form}
        onClose={closeForm}
        dirty={name !== '' || code !== ''}
        title="New industry"
        description="The code is permanent; the name is not."
      >
        <IndustryFields name={name} code={code} setName={setName} setCode={setCode} onDone={closeForm} />
      </Dialog>

      <Dialog open={wide} onClose={() => setWide(false)} wide title="Full-size evidence" description={`${subject} · Sr. 12 · S2 Set in order`}>
        <div className="gb-dialog-section">
          <div className="gb-na" style={{ height: 240 }} aria-label="Photo placeholder" role="img" />
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirm !== 'idle'}
        title={`Archive ${subject}?`}
        confirmLabel="Archive"
        pendingLabel="Archiving…"
        pending={confirm === 'pending'}
        error={confirm === 'failed' ? { message: 'This Zone has an audit in progress. Finish or cancel it first.' } : null}
        onCancel={() => setConfirm('idle')}
        onConfirm={() => {
          setConfirm('pending');
          // The first press fails, to show the error in place; the next one succeeds.
          void wait(700).then(() => {
            if (failedOnce.current) {
              setConfirm('idle');
            } else {
              failedOnce.current = true;
              setConfirm('failed');
            }
          });
        }}
      >
        It leaves every list and picker. Its audits and photos stay on record.
      </ConfirmDialog>
    </div>
  );
}

function IndustryFields({
  name,
  code,
  setName,
  setCode,
  onDone,
}: {
  name: string;
  code: string;
  setName: (value: string) => void;
  setCode: (value: string) => void;
  onDone: () => void;
}) {
  const close = useDialogClose();
  const missing = !name.trim() ? 'Enter a name to continue.' : !code.trim() ? 'Enter a code to continue.' : null;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!missing) onDone();
      }}
    >
      <div className="gb-dialog-section grid gap-3">
        <Field label="Name" hint="e.g. Hospital">
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Code" hint="Capitals and underscores, e.g. HOSPITAL">
          <Input className="font-mono" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} />
        </Field>
      </div>
      <DialogActions reason={missing}>
        <Button type="button" variant="secondary" onClick={close}>
          Cancel
        </Button>
        <Button type="submit" disabled={missing !== null}>
          Add industry
        </Button>
      </DialogActions>
    </form>
  );
}

function RegisterDemo({ zones }: { zones: DemoZone[] }) {
  const [archived, setArchived] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const failedOnce = useRef(false);
  const rows = zones.filter((zone) => !archived.includes(zone.id));

  if (rows.length === 0) {
    return (
      <EmptyState
        title="Every Zone is archived."
        action={
          <Button variant="secondary" onClick={() => setArchived([])}>
            Restore the demo
          </Button>
        }
      />
    );
  }

  return (
    <Table variant="register" label="Zones">
      <thead>
        <tr>
          <Th width="34%">Zone</Th>
          <Th width="26%">Leader</Th>
          <Th width="18%">Band</Th>
          <Th width="22%">
            <span className="sr-only">Actions</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((zone) => (
          <tr key={zone.id}>
            <Td>{zone.name}</Td>
            <Td>{zone.leader}</Td>
            <Td>
              <BandLabel score={zone.score} />
            </Td>
            <Td>
              <RowActions
                subject={zone.name}
                primary={
                  <Button variant="secondary" className="gb-btn--sm" onClick={() => setEditing(editing === zone.id ? null : zone.id)}>
                    {editing === zone.id ? 'Close' : 'Edit'}
                  </Button>
                }
                items={[
                  { label: 'Copy link', onSelect: () => undefined },
                  { label: 'Change leader', onSelect: () => undefined, disabled: zone.leader === '—', hint: 'This Zone has no leader yet. Add one with Edit.' },
                  {
                    label: 'Archive',
                    danger: true,
                    confirm: {
                      title: `Archive ${zone.name}?`,
                      body: 'It leaves every list and picker. Its audits and photos stay on record.',
                      confirmLabel: 'Archive',
                      pendingLabel: 'Archiving…',
                      run: async () => {
                        await wait(600);
                        if (zone.id === 'z8' && !failedOnce.current) {
                          failedOnce.current = true;
                          throw { message: 'This Zone has an audit in progress. Finish or cancel it first.' };
                        }
                        setArchived((list) => [...list, zone.id]);
                      },
                    },
                  },
                ]}
              />
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function PanelDemo({ zones }: { zones: DemoZone[] }) {
  const panel = useRoutedPanel('panel');
  const zone = zones.find((candidate) => candidate.id === panel.id) ?? null;

  return (
    <div className="gb-withpanel">
      <ul className="gb-gallery-list">
        {zones.map((candidate) => (
          <li key={candidate.id}>
            <button
              type="button"
              className="gb-rowtoggle"
              aria-current={candidate.id === panel.id ? 'true' : undefined}
              onClick={() => panel.open(candidate.id)}
            >
              {candidate.name}
            </button>
          </li>
        ))}
      </ul>
      <SidePanel
        open={zone !== null}
        title={zone?.name ?? ''}
        subtitle={zone ? `Leader ${zone.leader}` : undefined}
        onClose={panel.close}
        tools={
          <>
            <Button variant="secondary" className="gb-btn--sm">
              Open audit
            </Button>
            <Button className="gb-btn--sm">Generate report</Button>
          </>
        }
      >
        {zone ? (
          <div className="grid gap-3">
            <BandLabel score={zone.score} />
            <p className="m-0 text-[13px] text-ink-2">
              Opened from the URL: reload keeps it, Back closes it, Esc closes it, and focus returns to
              the row that opened it.
            </p>
            {Array.from({ length: 12 }, (_, index) => (
              <p key={index} className="m-0 text-[13px]">
                Finding {index + 1}: a body long enough to scroll inside the panel.
              </p>
            ))}
          </div>
        ) : null}
      </SidePanel>
    </div>
  );
}

function SlipDemo({ subject }: { subject: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="grid gap-3">
      <div>
        <Button variant="secondary" onClick={() => setShown(false)} disabled={!shown}>
          Reset
        </Button>{' '}
        <Button onClick={() => setShown(true)} disabled={shown}>
          Archive (demo)
        </Button>
      </div>
      {shown ? (
        <Slip title={`${subject} archived`} onDismiss={() => setShown(false)}>
          It no longer appears in lists or pickers. Its audits and photos stay on record.
        </Slip>
      ) : null}
    </div>
  );
}
