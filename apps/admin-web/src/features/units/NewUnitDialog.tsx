import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ChecklistTemplate,
  CreateUserResponse,
  Industry,
  MembershipDetail,
  Page,
  Unit,
  User,
  Zone,
} from '@audit5s/contracts';
import { ZONE_NUMBER_MAX, ZONE_NUMBER_MIN } from '@audit5s/contracts';
import { formatDateTime, zoneCodeForNumber, zoneDisplayLabel } from '@audit5s/domain';
import { api } from '@/lib/api';
import { devGet } from '@/features/units/worst-case';
import { newId } from '@/features/corrective-actions/PublicCorrectiveActionPage';
import { Button, Dialog, DialogActions, ErrorNotice, Field, Input, Select } from '@/components/ui';

const STEPS = ['Unit', 'Zones', 'Industry and checklist', 'Coordinator', 'Review'] as const;

interface ZoneDraft {
  id: string;
  number: string;
  name: string;
}

type CoordinatorMode = 'new' | 'existing' | 'later';

/** What has been created so far. Kept across a failed attempt, so Try again never makes anything twice. */
interface Created {
  unit: Unit | null;
  zones: Record<string, Zone>;
  coordinator: { fullName: string; issued: CreateUserResponse | null } | null;
}

const NOTHING_CREATED: Created = { unit: null, zones: {}, coordinator: null };

/**
 * "New Unit" as one sitting (report §5 Task 1): the Unit, its Zones, its industry and
 * default checklist, its Coordinator, then a review. Nothing is created until Create on the
 * review; then each piece goes to its existing endpoint in order.
 *
 * Partial failure: whatever was created is remembered here and locked, and Try again
 * carries on from the piece that failed. Each request also carries an Idempotency-Key tied
 * to its body, so a request whose answer was lost replays its first result instead of
 * making a second Unit.
 */
export function NewUnitDialog({
  open,
  onClose,
}: {
  open: boolean;
  /** `unitId` when a Unit now exists, so the list can open its row. */
  onClose: (unitId: string | null) => void;
}) {
  const [dirty, setDirty] = useState(false);
  const [unitId, setUnitId] = useState<string | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const close = () => {
    onClose(unitId);
    setUnitId(null);
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      wide
      title="New Unit"
      description="The plant, its Zones, its checklist and who runs it. Nothing is created until you press Create on the last step."
      dirty={dirty}
      initialFocus={nameField}
    >
      {open ? (
        <Stepper
          nameField={nameField}
          onDirty={setDirty}
          onUnit={setUnitId}
          onFinish={close}
        />
      ) : null}
    </Dialog>
  );
}

function Stepper({
  nameField,
  onDirty,
  onUnit,
  onFinish,
}: {
  nameField: RefObject<HTMLInputElement | null>;
  onDirty: (dirty: boolean) => void;
  onUnit: (unitId: string) => void;
  onFinish: () => void;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [showErrors, setShowErrors] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [zones, setZones] = useState<ZoneDraft[]>([{ id: newId(), number: '1', name: '' }]);
  const [industryId, setIndustryId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [mode, setMode] = useState<CoordinatorMode>('new');
  const [person, setPerson] = useState({ fullName: '', phone: '', email: '' });
  const [existingId, setExistingId] = useState('');

  const [created, setCreated] = useState<Created>(NOTHING_CREATED);
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [finished, setFinished] = useState(false);

  const units = useQuery({ queryKey: ['units'], queryFn: () => devGet<Page<Unit>>('/units?limit=200') });
  const industries = useQuery({ queryKey: ['industries', false], queryFn: () => api.get<Industry[]>('/industries') });
  const templates = useQuery({
    queryKey: ['checklist-templates'],
    queryFn: () => api.get<Page<ChecklistTemplate>>('/checklist-templates?limit=200'),
  });
  const coordinators = useQuery({
    queryKey: ['users', 'coordinators'],
    queryFn: () => api.get<Page<User>>('/users?role=COORDINATOR&limit=200'),
  });
  const placed = useQuery({
    queryKey: ['memberships', 'role', 'COORDINATOR'],
    queryFn: () => devGet<Page<MembershipDetail>>('/memberships?role=COORDINATOR&status=ACTIVE&limit=200'),
  });

  // Typed something, and nothing is on record yet: closing asks first. Once the Unit exists,
  // closing keeps it, and the list opens its row.
  const touched = name.trim() !== '' || city.trim() !== '' || zones.some((zone) => zone.name.trim());
  useEffect(() => {
    onDirty(touched && !created.unit);
    return () => onDirty(false);
  }, [touched, created.unit, onDirty]);

  // Each step lands focus on its own heading, so a screen reader hears where it is.
  // Compared with the last step shown, not "skip the first run": StrictMode runs it twice.
  const lastShown = useRef({ step, finished });
  useEffect(() => {
    if (lastShown.current.step === step && lastShown.current.finished === finished) return;
    lastShown.current = { step, finished };
    heading.current?.focus();
  }, [step, finished]);

  // Validation, per step.
  const trimmedName = name.trim();
  const nameTaken = (units.data?.data ?? []).some(
    (unit) => unit.name.toLocaleLowerCase() === trimmedName.toLocaleLowerCase() && unit.id !== created.unit?.id,
  );
  const unitError = !trimmedName ? 'Enter the Unit’s name.' : nameTaken ? 'A Unit with this name already exists.' : undefined;

  // A row counts once it has a name; its number is filled in for it.
  const zoneRows = zones.filter((zone) => zone.name.trim());
  const zoneErrors = (zone: ZoneDraft): { number?: string; name?: string } => {
    const parsed = Number(zone.number);
    const number =
      !Number.isInteger(parsed) || parsed < ZONE_NUMBER_MIN || parsed > ZONE_NUMBER_MAX || !zone.number.trim()
        ? `${ZONE_NUMBER_MIN} to ${ZONE_NUMBER_MAX}`
        : zoneRows.some((other) => other.id !== zone.id && Number(other.number) === parsed)
          ? 'Used twice'
          : undefined;
    return { number, name: zone.name.trim() ? undefined : 'Enter a name' };
  };
  const zonesValid = zoneRows.every((zone) => {
    const errors = zoneErrors(zone);
    return !errors.number && !errors.name;
  });

  const phoneDigits = person.phone.replace(/\D/g, '');
  const coordinatorError =
    mode === 'new'
      ? !person.fullName.trim()
        ? 'Enter the Coordinator’s full name.'
        : phoneDigits.length !== 10
          ? 'Enter a 10-digit mobile number.'
          : undefined
      : mode === 'existing' && !existingId
        ? 'Choose a Coordinator.'
        : undefined;

  const stepError = [unitError, zonesValid ? undefined : 'Fix the marked Zones.', undefined, coordinatorError, undefined][step];

  // Checklists this Unit is offered (0042): ticked for its industry, or ticked for none.
  const offered = (templates.data?.data ?? []).filter(
    (template) =>
      !industryId ||
      template.industries.length === 0 ||
      template.industries.some((industry) => industry.id === industryId),
  );

  const placedIds = new Set((placed.data?.data ?? []).map((membership) => membership.userId));
  const freeCoordinators = (coordinators.data?.data ?? []).filter(
    (user) => user.status === 'ACTIVE' && !user.archivedAt && !placedIds.has(user.id),
  );
  const industryName = industries.data?.find((industry) => industry.id === industryId)?.name;
  // A checklist chosen, then the industry changed so it is no longer offered, is let go.
  const template = offered.find((candidate) => candidate.id === templateId);
  const existingName = freeCoordinators.find((user) => user.id === existingId)?.fullName;

  // One key per piece, renewed only when what is sent changes.
  const keys = useRef(new Map<string, { body: string; key: string }>());
  const post = <T,>(id: string, path: string, body: unknown): Promise<T> => {
    const json = JSON.stringify(body);
    let held = keys.current.get(id);
    if (held?.body !== json) {
      held = { body: json, key: newId() };
      keys.current.set(id, held);
    }
    return api.post<T>(path, body, held.key);
  };

  const create = async () => {
    setCreating(true);
    setFailure(null);
    // A local copy as well as state, so each await below sees what the one before it made.
    const made: Created = { ...created, zones: { ...created.zones } };
    try {
      if (!made.unit) {
        made.unit = await post<Unit>('unit', '/units', {
          name: trimmedName,
          city: city.trim() || undefined,
          industryId: industryId || undefined,
        });
        setCreated({ ...made });
        onUnit(made.unit.id);
      }
      for (const zone of zoneRows) {
        if (made.zones[zone.id]) continue;
        const number = Number(zone.number);
        made.zones[zone.id] = await post<Zone>(zone.id, `/units/${made.unit.id}/zones`, {
          code: zoneCodeForNumber(number),
          name: zone.name.trim(),
          sortOrder: number,
          defaultChecklistTemplateId: template?.id,
        });
        setCreated({ ...made, zones: { ...made.zones } });
      }
      if (!made.coordinator && mode === 'new') {
        const issued = await post<CreateUserResponse>('coordinator', '/users', {
          fullName: person.fullName.trim(),
          phone: phoneDigits,
          email: person.email.trim() || undefined,
          role: 'COORDINATOR',
          unitId: made.unit.id,
        });
        made.coordinator = { fullName: issued.user.fullName, issued };
        setCreated({ ...made });
      }
      if (!made.coordinator && mode === 'existing') {
        await post('coordinator', `/units/${made.unit.id}/memberships`, { userId: existingId });
        made.coordinator = { fullName: existingName ?? '', issued: null };
        setCreated({ ...made });
      }
      setFinished(true);
    } catch (error) {
      setFailure(error);
    } finally {
      setCreating(false);
      if (made.unit) {
        for (const key of ['units', 'zones', 'memberships', 'users', 'unit']) {
          void queryClient.invalidateQueries({ queryKey: [key] });
        }
      }
    }
  };

  const next = (event: FormEvent) => {
    event.preventDefault();
    if (step === STEPS.length - 1) {
      void create();
      return;
    }
    if (stepError) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    setStep(step + 1);
  };
  const goTo = (target: number) => {
    setShowErrors(false);
    setStep(target);
  };

  if (finished && created.unit) {
    return (
      <>
        <div className="gb-dialog-section space-y-3 text-sm">
          <h3 ref={heading} tabIndex={-1} className="gb-h2 outline-none">
            {created.unit.name} is set up
          </h3>
          <ul className="space-y-1">
            <li>
              {Object.keys(created.zones).length
                ? `${Object.keys(created.zones).length} Zone${Object.keys(created.zones).length === 1 ? '' : 's'}, ready for audits.`
                : 'No Zones yet. Add them on its row, or an auditor names them in the field.'}
            </li>
            <li>
              {created.coordinator
                ? `${created.coordinator.fullName} runs it as Coordinator.`
                : 'No Coordinator yet. Add one from Users, or Edit on its row.'}
            </li>
          </ul>
          {created.coordinator?.issued && (
            <div className="border border-edge-soft bg-board p-3">
              <p className="font-medium">
                {created.coordinator.fullName} signs in as{' '}
                <span className="font-mono">{created.coordinator.issued.loginId}</span>
              </p>
              <p className="text-ink-2">
                Their temporary password is their own mobile number. They must change it on first
                sign-in, and it stops working {formatDateTime(new Date(created.coordinator.issued.bootstrapExpiresAt))}.
              </p>
            </div>
          )}
        </div>
        <DialogActions>
          <Button type="button" onClick={onFinish}>
            Show its Zones
          </Button>
        </DialogActions>
      </>
    );
  }

  const unitLocked = Boolean(created.unit);
  const allZonesMade = zoneRows.length > 0 && zoneRows.every((zone) => created.zones[zone.id]);
  const shown = (message: string | undefined) => (showErrors ? message : undefined);

  return (
    <form onSubmit={next} noValidate>
      <ol className="flex flex-wrap gap-x-4 gap-y-1 border-b border-edge-soft px-[18px] py-2 text-xs">
        {STEPS.map((label, position) => (
          <li
            key={label}
            aria-current={position === step ? 'step' : undefined}
            className={position === step ? 'font-semibold text-ink' : 'text-ink-2'}
          >
            {position < step ? '✓ ' : `${position + 1} · `}
            {label}
          </li>
        ))}
      </ol>

      <div className="gb-dialog-section grid gap-3">
        <h3 ref={heading} tabIndex={-1} className="gb-label outline-none">
          Step {step + 1} of {STEPS.length}: {STEPS[step]}
        </h3>

        {step === 0 && (
          <>
            <Field
              label="Name"
              hint={unitLocked ? 'Created. Change it later with Edit on its row.' : 'Auditors and reports see this, e.g. Nashik Plant.'}
              error={unitLocked ? undefined : shown(unitError) ?? (nameTaken ? unitError : undefined)}
            >
              <Input ref={nameField} value={name} disabled={unitLocked} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field label="City (optional)">
              <Input value={city} disabled={unitLocked} onChange={(event) => setCity(event.target.value)} />
            </Field>
            <p className="gb-hint">Time zone is India (IST). Address and contact can be added after.</p>
          </>
        )}

        {step === 1 && (
          <ZonesTable
            zones={zones}
            created={created.zones}
            showErrors={showErrors}
            errorsOf={zoneErrors}
            onChange={setZones}
          />
        )}

        {step === 2 && (
          <>
            <Field
              label="Industry (optional)"
              hint={unitLocked ? 'Created. Change it later with Edit on its row.' : 'Decides which checklists this Unit is offered. “Not set” offers every checklist.'}
            >
              <Select value={industryId} disabled={unitLocked} onChange={(event) => setIndustryId(event.target.value)}>
                <option value="">Not set</option>
                {(industries.data ?? []).map((industry) => (
                  <option key={industry.id} value={industry.id}>
                    {industry.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Default checklist (optional)"
              hint={
                zoneRows.length === 0
                  ? 'No Zones to give it to. Each Zone can be given one later.'
                  : `Each of the ${zoneRows.length} new Zone${zoneRows.length === 1 ? '' : 's'} starts with it. Missing one? Link it to the industry on Industries.`
              }
            >
              <Select
                value={template?.id ?? ''}
                disabled={zoneRows.length === 0 || allZonesMade}
                onChange={(event) => setTemplateId(event.target.value)}
              >
                <option value="">None</option>
                {offered.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </Select>
            </Field>
            {(industries.error || templates.error) && <ErrorNotice error={industries.error ?? templates.error} />}
          </>
        )}

        {step === 3 && (
          <>
            <fieldset disabled={Boolean(created.coordinator)}>
              <legend className="sr-only">Who runs this Unit?</legend>
              <div className="gb-choice">
                <label>
                  <input type="radio" name="coordinator" checked={mode === 'new'} onChange={() => setMode('new')} />
                  <b>Add a new person</b>
                  <span>They get a login ID; their mobile number is the first password.</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="coordinator"
                    checked={mode === 'existing'}
                    disabled={freeCoordinators.length === 0}
                    onChange={() => setMode('existing')}
                  />
                  <b>Someone already here</b>
                  <span>
                    {freeCoordinators.length
                      ? `${freeCoordinators.length} Coordinator${freeCoordinators.length === 1 ? '' : 's'} without a Unit.`
                      : 'Every Coordinator already runs a Unit.'}
                  </span>
                </label>
                <label>
                  <input type="radio" name="coordinator" checked={mode === 'later'} onChange={() => setMode('later')} />
                  <b>Later</b>
                  <span>Nobody runs it yet; add one from Users.</span>
                </label>
              </div>
            </fieldset>
            {mode === 'new' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Full name" error={shown(person.fullName.trim() ? undefined : coordinatorError)}>
                  <Input
                    value={person.fullName}
                    disabled={Boolean(created.coordinator)}
                    placeholder="Rahul Sharma"
                    onChange={(event) => setPerson({ ...person, fullName: event.target.value })}
                  />
                </Field>
                <Field
                  label="Mobile number"
                  hint="10 digits. Also the temporary password, for 72 hours."
                  error={shown(person.fullName.trim() ? coordinatorError : undefined)}
                >
                  <Input
                    type="tel"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={10}
                    placeholder="9876543210"
                    value={person.phone}
                    disabled={Boolean(created.coordinator)}
                    onChange={(event) => setPerson({ ...person, phone: event.target.value.replace(/\D/g, '').slice(0, 10) })}
                  />
                </Field>
                <Field label="Email (optional)">
                  <Input
                    type="email"
                    value={person.email}
                    disabled={Boolean(created.coordinator)}
                    onChange={(event) => setPerson({ ...person, email: event.target.value })}
                  />
                </Field>
              </div>
            )}
            {mode === 'existing' && (
              <Field label="Coordinator" error={shown(coordinatorError)}>
                <Select value={existingId} disabled={Boolean(created.coordinator)} onChange={(event) => setExistingId(event.target.value)}>
                  <option value="">Choose…</option>
                  {freeCoordinators.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.fullName} ({user.loginId})
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {(coordinators.error || placed.error) && <ErrorNotice error={coordinators.error ?? placed.error} />}
          </>
        )}

        {step === 4 && (
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr_auto]">
            <Review label="Unit" onChange={() => goTo(0)} done={unitLocked}>
              {trimmedName}
              {city.trim() ? `, ${city.trim()}` : ''}
            </Review>
            <Review label="Zones" onChange={() => goTo(1)} done={allZonesMade}>
              {zoneRows.length
                ? zoneRows.map((zone) => (
                    <span key={zone.id} className="block">
                      {created.zones[zone.id] ? '✓ ' : ''}
                      {zoneDisplayLabel(zoneCodeForNumber(Number(zone.number)), zone.name.trim())}
                    </span>
                  ))
                : 'None yet. An auditor can name them in the field.'}
            </Review>
            <Review label="Industry" onChange={() => goTo(2)} done={unitLocked}>
              {industryName ?? 'Not set: every checklist is offered'}
            </Review>
            <Review label="Default checklist" onChange={() => goTo(2)} done={allZonesMade}>
              {zoneRows.length ? (template?.name ?? 'None') : '—'}
            </Review>
            <Review label="Coordinator" onChange={() => goTo(3)} done={Boolean(created.coordinator)}>
              {mode === 'new'
                ? `${person.fullName.trim()}, new (${phoneDigits})`
                : mode === 'existing'
                  ? existingName
                  : 'Later'}
            </Review>
          </dl>
        )}

        {failure ? (
          <div className="space-y-2">
            <ErrorNotice error={failure} />
            {created.unit && (
              <p className="text-sm">
                {created.unit.name} was created{Object.keys(created.zones).length ? ', with the Zones marked ✓' : ''}.
                Fix what failed and press Try again, which carries on from there. If you close now,
                the rest can be added on its row.
              </p>
            )}
          </div>
        ) : null}
      </div>

      <DialogActions reason={showErrors ? stepError : undefined}>
        {step > 0 && (
          <Button type="button" variant="secondary" disabled={creating} onClick={() => goTo(step - 1)}>
            Back
          </Button>
        )}
        {(step === 1 || step === 3) && (
          <Button
            type="button"
            variant="secondary"
            disabled={creating}
            onClick={() => {
              if (step === 1) setZones(zones.filter((zone) => created.zones[zone.id]));
              else if (!created.coordinator) setMode('later');
              goTo(step + 1);
            }}
          >
            Skip for now
          </Button>
        )}
        <Button type="submit" disabled={creating}>
          {step < STEPS.length - 1
            ? 'Next'
            : creating
              ? 'Creating…'
              : failure
                ? 'Try again'
                : 'Create Unit'}
        </Button>
      </DialogActions>
    </form>
  );
}

function Review({
  label,
  done,
  onChange,
  children,
}: {
  label: string;
  done: boolean;
  onChange: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <dt className="gb-label col-span-2 pt-1 sm:col-span-1">{label}</dt>
      <dd className="min-w-0 break-words pt-1">{children}</dd>
      <dd>
        {done ? (
          <span className="text-xs text-ink-2">Created</span>
        ) : (
          <Button type="button" variant="secondary" onClick={onChange} aria-label={`Change ${label}`}>
            Change
          </Button>
        )}
      </dd>
    </>
  );
}

/** Zones as table entry: a number and a name a row, Enter in a name adds the next row. */
function ZonesTable({
  zones,
  created,
  showErrors,
  errorsOf,
  onChange,
}: {
  zones: ZoneDraft[];
  created: Record<string, Zone>;
  showErrors: boolean;
  errorsOf: (zone: ZoneDraft) => { number?: string; name?: string };
  onChange: (zones: ZoneDraft[]) => void;
}) {
  const nameInputs = useRef(new Map<string, HTMLInputElement>());
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => {
    if (focusId) nameInputs.current.get(focusId)?.focus();
  }, [focusId]);

  const update = (id: string, patch: Partial<ZoneDraft>) =>
    onChange(zones.map((zone) => (zone.id === id ? { ...zone, ...patch } : zone)));
  const add = () => {
    const used = new Set(zones.map((zone) => Number(zone.number)));
    let number = ZONE_NUMBER_MIN;
    while (used.has(number) && number < ZONE_NUMBER_MAX) number += 1;
    const id = newId();
    onChange([...zones, { id, number: String(number), name: '' }]);
    setFocusId(id);
  };

  return (
    <>
      <p className="gb-hint">
        One row per area to be audited. A row left without a name is dropped. Leaders can be named later,
        on the Unit’s row.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left">
            <th className="gb-label w-24 pb-1 font-normal">Zone no.</th>
            <th className="gb-label pb-1 font-normal">Name</th>
            <th className="w-24 pb-1">
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {zones.map((zone, index) => {
            const made = Boolean(created[zone.id]);
            const errors = showErrors && zone.name.trim() ? errorsOf(zone) : {};
            return (
              <tr key={zone.id} className="align-top">
                <td className="pr-2 pb-2">
                  <Input
                    aria-label={`Zone ${index + 1} number`}
                    aria-invalid={Boolean(errors.number)}
                    inputMode="numeric"
                    maxLength={3}
                    className="gb-data w-full"
                    value={zone.number}
                    disabled={made}
                    onChange={(event) => update(zone.id, { number: event.target.value.replace(/\D/g, '').slice(0, 3) })}
                  />
                  {errors.number && <span className="gb-field-error block">{errors.number}</span>}
                </td>
                <td className="pr-2 pb-2">
                  <Input
                    ref={(element) => {
                      if (element) nameInputs.current.set(zone.id, element);
                      else nameInputs.current.delete(zone.id);
                    }}
                    aria-label={`Zone ${index + 1} name`}
                    aria-invalid={Boolean(errors.name)}
                    placeholder={index === 0 ? 'Press shop' : undefined}
                    className="w-full"
                    value={zone.name}
                    disabled={made}
                    onChange={(event) => update(zone.id, { name: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && index === zones.length - 1 && zone.name.trim()) {
                        event.preventDefault();
                        add();
                      }
                    }}
                  />
                  {errors.name && <span className="gb-field-error block">{errors.name}</span>}
                </td>
                <td className="pb-2">
                  {made ? (
                    <span className="text-xs text-ink-2">✓ Created</span>
                  ) : (
                    <Button
                      type="button"
                      variant="secondary"
                      aria-label={`Remove Zone ${index + 1}`}
                      onClick={() => onChange(zones.filter((other) => other.id !== zone.id))}
                    >
                      Remove
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div>
        <Button type="button" variant="secondary" onClick={add} disabled={zones.length >= ZONE_NUMBER_MAX}>
          Add a Zone
        </Button>
      </div>
    </>
  );
}
