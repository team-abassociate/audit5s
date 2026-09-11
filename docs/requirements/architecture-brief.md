You are a Principal Software Architect and Senior Full-Stack Engineer.

I am building a production-grade 5S Audit Management Platform. Your job is to convert the product requirements in `brainstorm.md` into a complete, technically sound implementation plan and then design the application architecture.

Do not blindly translate requirements into screens. First identify the underlying domain model, workflows, permissions, invariants, state transitions, offline requirements, security requirements, reporting requirements, and integration boundaries.

The application has four business roles:

1. Super Admin
2. Consultant
3. Coordinator
4. Zone Leader

Use these as the canonical role names everywhere.

BUSINESS HIERARCHY

Super Admin
├── manages Units
├── manages Consultants
├── assigns one or many Consultants to Units
├── manages Coordinators
├── assigns Coordinators to Units (the coordinator is an employee of the unit)
├── creates external audit assignments
├── sees all audit activity
├── generates official reports
└── sees organization-wide analytics

Coordinator
├── belongs to one Unit
├── cannot rename/change their assigned Unit
├── maintains Unit master data
├── creates Zones
├── creates Zone descriptions
├── creates/manages Zone Leaders
├── sees external audit assignments
├── sees cross-audit activity
└── sees Unit/Zone trends

Consultant
├── may be assigned to multiple Units
├── performs external 5S audits
├── performs walk-by audits
├── captures selfie before starting an audit
├── records GPS/location
├── captures audit evidence
├── works offline
└── sees assigned Units, own audit history and own completed zone score summaries

Zone Leader
├── belongs to a Unit
├── can conduct cross audits
├── can access all active Zones belonging to their Unit
├── sees relevant external/cross audit nonconformities
├── uploads corrective-action evidence
└── sees audit history

IMPORTANT DOMAIN RULE

Do not permanently bind a Zone Leader to only one Zone for conducting audits. Once Zones are created by the Coordinator, authorized Zone Leaders should be able to audit any active Zone belonging to their Unit.

TECHNOLOGY ARCHITECTURE

Prefer the following unless there is a strong technical reason to change it:

Monorepo:
- TypeScript

Admin portal:
- Next.js
- React
- Tailwind
- shadcn/ui
- TanStack Query
- Recharts/ECharts

Field application:
- React Native
- Expo prebuild/native modules where required
- SQLite local database
- native camera
- GPS/location
- offline-first synchronization

Backend:
- NestJS
- PostgreSQL
- Prisma
- Redis
- BullMQ
- REST API initially

Files:
- S3-compatible object storage

Authentication/security:
- JWT access token
- refresh-token rotation
- Argon2/bcrypt password hashing
- server-side authorization
- RBAC + resource-scoped permissions

Notifications:
- in-app notification center
- WhatsApp integration
- SMS fallback
- asynchronous notification jobs

Deployment:
- Docker
- managed PostgreSQL
- managed Redis
- S3-compatible storage
- CI/CD
- staging and production environments

Use a modular monolith architecture initially. Do not introduce microservices unless concrete scaling boundaries justify them.

REQUIRED BACKEND MODULES

Design clear module boundaries for:

- Authentication
- Users
- Roles / Permissions
- Units
- Unit Memberships
- Consultants
- Coordinators
- Zone Leaders
- Zones
- Audit Assignments
- Checklist Templates
- Checklist Versions
- Checklist Questions
- Audits
- Audit Zones
- Question Responses
- Evidence
- Corrective Actions
- Reports
- Notifications
- Offline Synchronization
- Analytics
- Audit Logs

MULTI-TENANCY / ACCESS CONTROL

Authorization must not be based on role alone.

Every operation must check both:

1. role permission
2. resource scope

Example:

A Coordinator can edit a Zone only if:

user.role == COORDINATOR

AND

zone.unit_id == coordinator.unit_id

Consultants may only access Units assigned through active UnitMembership / assignment records.

Zone Leaders may only access Zones belonging to their Unit.

Super Admin has organization-wide access.

DATABASE

Produce a normalized relational data model.

At minimum consider tables/entities for:

User
Unit
UnitMembership
Zone
ChecklistTemplate
ChecklistVersion
ChecklistQuestion
AuditAssignment
Audit
AuditZone
QuestionResponse
Evidence
CorrectiveAction
CorrectiveActionSubmission
ReportSnapshot
Notification
AuditLog
DeviceSyncRecord

Show:

- primary keys
- foreign keys
- important indexes
- uniqueness constraints
- enums
- soft-delete/archive strategy
- timestamps
- versioning strategy

CHECKLIST SYSTEM

The 50 questions are hardcoded into application screens based on an Excel sheet containing department-specific 5S questions.
The xlsx file for the same is attached.


Create a versioned checklist system.

Each checklist contains exactly five S sections:

1S Sort
2S Set in Order
3S Shine
4S Standardize
5S Sustain

Each S only contains 10 questions.

An audit must reference an immutable checklist version so that future checklist edits do not modify historical audits.

Design an Excel import process with:

- validation
- preview
- duplicate checking
- version creation
- activation/deactivation
- error reporting

AUDIT TYPES

Support:

EXTERNAL_5S
CROSS_5S
WALK_BY 5S

FULL 5S AUDIT

For each Zone:

1. Select Zone(Zone dropdown from Zone 1 to Zone 100)
2. Zone description
3. Zone leader
4. Select department/checklist
5. Start audit
6. Complete 1S questions
7. Complete 2S questions
8. Complete 3S questions
9. Complete 4S questions
10. Complete 5S questions
11. Finish Zone
12. Add next Zone or Finish Audit

Each question supports:

2 = Well Implemented
1 = Progressing Well
0 = Needs Improvement
NA = Not Applicable

SCORING

The denominator must dynamically exclude NA responses.

Formula:

applicable_questions = total_questions - NA_questions

maximum_score = applicable_questions * 2

score_percentage =
sum(response_scores) / maximum_score * 100

Calculate:

- S-wise score
- Zone score
- Audit score
- Unit trends

AUDIT STATE MACHINE

Do not implement audit status as arbitrary strings.

Design an explicit state machine such as:

ASSIGNED
READY
IN_PROGRESS
PAUSED
COMPLETED
CORRECTIVE_ACTION_OPEN
PARTIALLY_CLOSED
CLOSED

An auditor's "Abort" action must never delete the audit.

It should save progress, notify the Super Admin and allow the auditor to resume from the previous question later.

EVIDENCE

Evidence must belong to a specific question response, not only to an Audit.

Each Evidence record should include fields such as:

- audit
- audit zone
- question response
- image object-storage key
- local device ID
- score at time of capture
- evidence classification
- optional remark
- summary flag
- GPS coordinates where applicable
- capture timestamp
- synchronization state

Evidence classification:

score 2:
GOOD

score 0 or 1:
NONCONFORMITY

NA:
NEUTRAL / not scored

Auditors can preview and delete photos before audit completion.

Remarks on evidence are optional.

Allow the auditor one optional flagged GOOD image and one optional flagged NONCONFORMITY image per Zone for summary reporting.
also give a optional remark field to the auditor after every question and at the end of 50 question the overall zone remark both should be optinal. these remarks will be in the zone reports.

Enforce this uniqueness logically.

CAMERA REQUIREMENTS

Consultants must capture a selfie before starting the audit.

Corrective-action evidence should use live-camera capture rather than gallery upload wherever the platform allows this reliably.

Walk-by audits require at least one live photo per Zone.

GEOLOCATION

Record Consultant location at login/audit start.

Also design optional Unit geofencing:

Unit should support:

latitude
longitude
geofence_radius

Record:

latitude
longitude
accuracy
captured_at

Flag suspicious audit starts outside the configured Unit radius.

Do not pretend mobile GPS provides perfect anti-spoofing. Record evidence and expose suspicious-location signals instead.

OFFLINE-FIRST REQUIREMENT

The field application must work safely with weak/no internet.

Do not make the questionnaire dependent on live server requests.

Use local SQLite as the immediate source of truth while an audit is in progress.

Required flow:

UI
→ SQLite transaction
→ synchronization queue
→ backend API
→ PostgreSQL/object storage

Define synchronization states:

LOCAL_ONLY
PENDING
SYNCING
SYNCED
FAILED

Every significant save should persist locally first.

Question responses must be saved after selection.

Photos should be queued and uploaded independently.

The UI must display:

- sync status
- unsynced item count
- last successful sync
- Sync Now button

Design idempotent server APIs so retries cannot duplicate responses or photos.

Explain your conflict-resolution strategy.

WALK-BY AUDIT

Flow: first auditor selfie then

1. Select Zone
2. Optional Zone description
3. Zone leader
4. Open camera
5. Capture minimum one photo
6. Optional additional photos
7. Optional remarks
8. Save Zone
9. Add another Zone or Finish Audit

CORRECTIVE ACTION WORKFLOW

Every NONCONFORMITY evidence item should produce an independently trackable corrective-action item.

The Zone Leader can choose:

OPTION A
Action completed:
- zone leader name
- live after-evidence photo
- corrective-action description
- Submit

OPTION B
Not possible:
- explanation/comment
- Submit

Corrective-action states should support:

OPEN
ACTION_SUBMITTED
NOT_POSSIBLE
VERIFIED
REOPENED

Partial submissions must remain saved permanently.

If five nonconformities exist and only three are addressed, the three submitted actions must never be discarded when the remaining two are completed later.

Submitting corrective action should trigger a Super Admin notification.

REPORTING

Official report generation belongs to Super Admin only.

Consultants may see their Zone score summary, but cannot generate official PDFs.

Generate reports from immutable report snapshots.

Required report types:

1. Initial Zone Report
2. After-Evidence Zone Report
3. Multi-Zone Summary Report

Initial Zone Report should contain:

- Unit
- audit metadata
- auditor
- auditor selfie
- Zone information
- S-wise scoring
- question responses
- evidence
- nonconformity evidence
- live corrective-action link(in form of a button)

GOOD evidence may be placed side by side.

NONCONFORMITY evidence should be left aligned with space on the right for after evidence(but nothing should be written there)

After-Evidence report should present:

BEFORE PHOTO | AFTER PHOTO

or:

BEFORE PHOTO | NOT POSSIBLE EXPLANATION

Do not overwrite the original report snapshot.
and the good photos to remain as it is in the after report
Generate a new version.

INTERACTIVE REPORT REQUIREMENT

Do not implement complex application logic inside PDF JavaScript.

Instead:

1. Generate a conventional PDF.
2. Include a secure "View / Submit Corrective Action" hyperlink/button.
3. Link to a responsive authenticated or signed-token web experience.
4. Handle photo upload, comments and submission on that page.
5. Allow Super Admin to regenerate an after-evidence PDF afterward.

Design secure token expiration/revocation for these report links.

SUMMARY REPORT

Super Admin chooses:

- one Zone
- several Zones
- Select All

Summary calculations must use only selected Zones.

Include:

- selected Zone count
- individual Zone scores
- highest-performing Zones
- lowest-performing Zones
- cumulative 5S/radar analysis
- one optionally flagged GOOD photo per Zone
- one optionally flagged NONCONFORMITY photo per Zone

ANALYTICS

Design analytics for both Super Admin and Coordinator.

Required metrics include:

- audit count
- audit frequency
- overall Unit score trend
- Zone score trend
- each S trend
- best-performing Zones
- weakest Zones
- open nonconformities
- recurrent nonconformities
- corrective-action closure rate
- average corrective-action closure time
- consultant activity
- Zone Leader activity
- improvement from previous audit
- Unit ranking where appropriate
- make the rport visually effective by using the colours of rating scale which is there in the attached sample zone report pdf

Design time-series queries and suitable indexes.

NOTIFICATIONS

Use domain events and asynchronous jobs.

Examples:

UNIT_ASSIGNED
AUDIT_ASSIGNED
AUDIT_STARTED
AUDIT_PAUSED
AUDIT_COMPLETED
CORRECTIVE_ACTION_SUBMITTED
REPORT_GENERATED
SYNC_FAILURE

Notification channels:

- in-app
- WhatsApp
- SMS fallback where configured

Do not call WhatsApp APIs directly from core audit transactions.

Publish an event/job and handle external messaging asynchronously.

LOGIN IDS

Business-requested login ID convention:

first two normalized letters of name
+
last four digits of phone number

Example:

Rahul Sharma + 9876543210
→ RA3210

Design deterministic collision handling such as:

RA3210
RA3210-2
RA3210-3

Never store passwords in plaintext.

The requirement currently proposes using the phone number as password. Treat this as a security risk.

Recommend using it only as an initial bootstrap password followed by forced reset or OTP authentication.

If business stakeholders insist on retaining the phone-number password, it must still be securely hashed and login attempts must be rate-limited.

AUDIT LOGGING

Sensitive administrative operations must be recorded:

- user created
- user disabled
- consultant assigned/revoked
- coordinator assigned
- Zone created/changed
- checklist imported
- audit changed after completion
- report generated
- corrective action verified
- permission changed

Store:

actor
action
resource type
resource ID
before
after
timestamp
IP/device metadata where appropriate

REQUIREMENT NORMALIZATION

Treat the following as final architectural decisions where the original brainstorm is inconsistent:

1. Consultant navigation:
   Units
   History
   Profile

2. Coordinator is the canonical term. Do not create separate "Admin" and "Coordinator" roles.

3. Coordinator manages Zone Leader accounts.

4. Zone Leaders can audit any active Zone belonging to their Unit.

5. Official report generation belongs only to Super Admin.

6. Consultants can view scoring summaries for audits they performed but cannot generate official reports.

7. "Abort" means save/pause/notify/resume, not delete.

8. Dynamic interactions and corrective-action uploads happen on a live web report rather than inside the PDF itself.

DELIVERABLES

Produce the architecture in the following order.

PART 1: Requirement normalization
- actors
- capabilities
- contradictions
- final decisions
- assumptions

PART 2: User journeys
Create end-to-end flows for:
- Super Admin
- Consultant
- Coordinator
- Zone Leader
- external audit
- cross audit
- walk-by 5S audit
- corrective action
- reporting

PART 3: System architecture
Provide a Mermaid architecture diagram showing:
- web
- mobile
- backend
- database
- Redis
- queues
- object storage
- WhatsApp/SMS
- report renderer

PART 4: Backend module architecture
Describe responsibility and dependencies of every module.

PART 5: Database architecture
Give a complete proposed schema including:
- entities
- fields
- PKs
- FKs
- indexes
- unique constraints
- enums
- relationships

Also produce an ER diagram in Mermaid.

PART 6: Authorization matrix
Create a matrix:

Resource × Action × Role × Scope

PART 7: State machines
Provide Mermaid state diagrams for:
- Audit
- AuditZone
- CorrectiveAction
- Evidence synchronization

PART 8: API design
Design REST endpoints grouped by module.

For each important endpoint include:
- method
- path
- role
- request
- response
- authorization rule
- idempotency behavior

PART 9: Offline synchronization design
Explain:
- local SQLite schema
- queue
- retry
- media upload
- conflict handling
- idempotency
- recovery from crashes
- logout with pending data
- audit resumption

PART 10: Reporting architecture
Explain:
- initial PDF
- live corrective-action report
- signed links
- after-evidence report
- summary report
- report versioning

PART 11: Analytics architecture
Define:
- metrics
- queries
- indexes
- aggregation strategy
- charts

PART 12: Security review
Cover:
- passwords
- JWT
- authorization
- IDOR
- tenant isolation
- signed media URLs
- link expiration
- GPS limitations
- file uploads
- camera evidence
- rate limiting
- audit logs
- encryption
- backups

PART 13: Repository structure

Recommend a monorepo structure such as:

apps/
  admin-web/
  field-mobile/
  api/

packages/
  types/
  validation/
  api-client/
  domain/
  ui/
  config/

PART 14: Implementation roadmap

Break work into phases:

Phase 1:
Foundation, authentication, RBAC, users and Units.

Phase 2:
Coordinator, Zones, Zone Leaders and checklist versioning/import.

Phase 3:
Audit engine and scoring.

Phase 4:
Mobile camera, selfie, GPS, SQLite and synchronization.

Phase 5:
Walk-by audit and evidence management.

Phase 6:
Corrective actions and notifications.

Phase 7:
PDF/reporting engine and live reports.

Phase 8:
Analytics.

Phase 9:
Hardening, observability, UAT and production deployment.

For every phase provide:
- backend tasks
- web tasks
- mobile tasks
- database migrations
- tests
- acceptance criteria

PART 15: Testing strategy

Include:
- unit testing
- authorization tests
- integration tests
- mobile offline tests
- synchronization tests
- E2E tests
- report snapshot tests
- concurrency tests
- security tests

Pay special attention to:

- two consultants auditing the same Unit
- intermittent internet
- duplicated sync requests
- changing checklist versions
- revoked Unit access
- incomplete audits
- partial corrective action
- photo upload failure
- retries
- changing a Zone's description after historical audits exist

PART 16: Production readiness checklist

Cover:
- logging
- monitoring
- crash reporting
- metrics
- backups
- restore testing
- migrations
- secrets
- CI/CD
- object-storage lifecycle
- image optimization
- privacy
- retention
- alerting

IMPORTANT

Do not immediately write application code.

First produce the architecture and implementation blueprint.

Challenge requirements that create security, reliability, maintainability or data-integrity problems.

Preserve historical audit data at all costs.

Prefer simple architecture with explicit domain boundaries over unnecessary abstraction.

The final architecture must be detailed enough that another senior engineering team can implement the product without reinterpreting the business workflow.