# Apple Health Import And Sync Plan

## Purpose

This document is the handoff-ready implementation plan for importing Apple Health export data from `data/HealthExport/*.json` into the app.

It covers both:

- workout session import for History and workout linking
- daily energy metric import for nutrition and macro/TDEE context

It is written so a fresh Codex session can execute it without re-deciding the architecture.

## Implementation Status

Current implementation status in the repo:

- backend schema and helper layer added in `database.js`
- `import-health.js` created and working for:
  - workout import
  - daily metric import
  - dry-run preview
  - upload-driven snapshot import
- import APIs added in `server.js`
- upload API added:
  - `POST /api/import/health/upload`
- History updated to show standalone imported Apple workouts
- tracked workout history detail now shows linked Apple Watch summaries
- Nutrition day response now includes imported Apple energy context
- Nutrition totals now show imported resting energy, active energy, and TDEE context
- Progress tab now includes an Apple Health upload flow with:
  - file picker
  - automatic preview after file selection
  - a simplified `X days of new data` / `No new data` preview summary
  - confirm import action
  - invalid-file error handling
- raw per-workout Apple series are now stored as JSON files under:
  - `data/health-raw/workouts/`
  - the DB stores lightweight references rather than the full raw arrays

Confirmed behaviors now implemented:

- imports are idempotent by Apple workout UUID and by metric date
- imported day-level energy skips the latest metric date present in each uploaded snapshot
- upload imports are treated as snapshots, not live sync
- imported rows track `source_snapshot_date`
- newer snapshots overwrite older imported rows
- older snapshots do not overwrite newer imported rows
- same-snapshot-date reimports are allowed to overwrite, which supports corrected re-exports
- dry-run/upload preview reports distinct affected dates so snapshot imports can be summarized as new-data days
- stale snapshot rows are counted in preview/import summaries instead of being silently ignored

Known current state note:

- an earlier manual test import brought in a current-day partial energy row before the snapshot-skipping rule existed
- going forward, upload-based imports will not recreate that partial-day issue
- if cleanup is needed for any previously imported partial current-day row, it should be handled explicitly rather than by assuming future imports will delete it

Recent UX/state follow-through:

- the upload modal no longer relies on a separate preview button; selecting a file automatically previews it
- the custom file picker keeps the selected filename visible across modal rerenders
- invalid uploads fail inline in the modal with explicit error messages
- linked Apple summaries in History are tappable and open the imported external-workout detail

## Locked Decisions

These decisions are chosen and should be treated as fixed unless explicitly changed later:

- Use **Option B**: keep Apple Health workouts in separate backend tables from the existing `workouts` table
- Keep Apple Health daily energy metrics in a separate per-day table from both `workouts` and workout-session import tables
- Only sync **`Functional Strength Training`** workouts to tracked workouts
- Import all other Apple workout types as standalone external workouts
- Ignore Apple workouts with **duration under 300 seconds** (5 minutes)
- Implement **Level 1 summary import first**
- Import daily **active** and **resting** energy metrics in v1 because macro tracking depends on them
- Do **not** auto-create tracked template workouts for unmatched Apple strength sessions in v1
- Keep the existing strength progression calculations based only on tracked set data in v1
- Make the import **idempotent** using Apple workout UUID as the canonical external key

## Source Data Confirmed

The export currently present in `data/HealthExport` contains:

- 58 workouts total
- 43 `Functional Strength Training`
- 7 `Indoor Walk`
- 7 `Tennis`
- 1 `Indoor Cycling`
- daily energy metric samples under `data.metrics[]`

The Apple workout JSON records are under:

- `data.workouts[]`

The Apple daily metric JSON records are under:

- `data.metrics[]`

Observed fields include:

- `id`
- `name`
- `start`
- `end`
- `duration`
- `avgHeartRate`
- `maxHeartRate`
- `heartRate`
- `activeEnergyBurned`
- `distance`
- `stepCadence`
- `intensity`
- `location`
- `isIndoor`
- `heartRateData`
- `activeEnergy`
- `stepCount`
- `walkingAndRunningDistance`
- `heartRateRecovery`

Example Apple activity types currently present:

- `Functional Strength Training`
- `Indoor Walk`
- `Tennis`
- `Indoor Cycling`

Daily metric records needed for nutrition import:

- `active_energy`
- `resting_energy`

## Existing App Constraints

The current app stores tracked workouts like this:

- `workouts`
  - `id`
  - `date`
  - `day_id`

Tracked workouts are:

- template-based
- exercise-based
- date-based
- not timestamped with start/end time

This is why external workout import must stay separate rather than extending the meaning of `workouts`.

## Chosen Backend Model

Use four separate concepts:

1. **Tracked workouts**
   - existing app workouts in `workouts`

2. **External workouts**
   - imported Apple Health workouts stored independently

3. **External workout links**
   - mapping rows linking a single external Apple strength workout to one or more tracked workouts on the same date

4. **Daily health metrics**
   - imported Apple Health day-level active and resting energy totals used by macro tracking

This model must support:

- standalone external workouts for `Tennis`, `Indoor Walk`, etc.
- one Apple `Functional Strength Training` workout linked to one tracked workout
- one Apple `Functional Strength Training` workout linked across multiple tracked workouts on the same date
- one per-date Apple energy summary for nutrition/TDEE features, independent of whether a workout was tracked that day

## Minimum Duration Filter

Hard rule:

- Skip any Apple workout where `duration < 300`

Implementation constant:

```js
const MIN_IMPORT_DURATION_SECONDS = 300;
```

Skipped-short workouts should:

- not be inserted into external tables
- not be linked to tracked workouts
- appear in dry-run/import report counts as `skipped_short_duration`

## Table Design

### 1. `external_workouts`

Purpose:

- canonical record for each imported Apple workout session

Required columns:

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `source_type TEXT NOT NULL`
  - always `apple_health` in v1
- `external_id TEXT NOT NULL UNIQUE`
  - Apple workout UUID
- `workout_type TEXT NOT NULL`
  - normalized activity type, e.g. `Functional Strength Training`
- `name TEXT NOT NULL`
  - raw display name from Apple export
- `date TEXT NOT NULL`
  - local date derived from `start_at`
- `start_at TEXT NOT NULL`
  - normalized ISO datetime string in local time with offset preserved if practical
- `end_at TEXT NOT NULL`
- `duration_seconds INTEGER NOT NULL`
- `is_indoor INTEGER`
- `location_label TEXT`
- `import_source_file TEXT NOT NULL`
- `imported_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`
- `import_level TEXT NOT NULL`
  - `summary`, `derived`, `full`
- `match_status TEXT NOT NULL`
  - `matched_single`, `matched_split`, `unmatched_strength`, `imported_standalone`

Indexes:

- unique index on `external_id`
- index on `(date, workout_type)`
- index on `match_status`

### 2. `external_workout_metrics`

Purpose:

- store summary values used for display and reporting

Required columns:

- `external_workout_id INTEGER PRIMARY KEY REFERENCES external_workouts(id) ON DELETE CASCADE`
- `active_energy_kcal REAL`
- `avg_heart_rate_bpm REAL`
- `max_heart_rate_bpm REAL`
- `min_heart_rate_bpm REAL`
- `distance_meters REAL`
- `step_count_total REAL`
- `avg_step_cadence REAL`
- `intensity_avg REAL`
- `temperature_avg REAL`
- `humidity_avg REAL`
- `elevation_up_meters REAL`
- `heart_rate_recovery_bpm REAL`

Notes:

- this table is one-row-per-external-workout
- values should be nullable because not every Apple workout contains every metric

### 3. `external_workout_raw`

Purpose:

- optional raw-series storage for Level 3

Required columns:

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `external_workout_id INTEGER NOT NULL REFERENCES external_workouts(id) ON DELETE CASCADE`
- `metric_key TEXT NOT NULL`
- `json_payload TEXT NOT NULL`

Unique constraint:

- unique on `(external_workout_id, metric_key)`

Metric keys expected in v3:

- `heartRateData`
- `activeEnergy`
- `stepCount`
- `walkingAndRunningDistance`
- `heartRateRecovery`

### 4. `external_workout_links`

Purpose:

- link one imported Apple strength workout to one or more tracked workouts

Required columns:

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `external_workout_id INTEGER NOT NULL REFERENCES external_workouts(id) ON DELETE CASCADE`
- `workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE`
- `link_kind TEXT NOT NULL`
  - always `strength_sync` in v1
- `link_order INTEGER NOT NULL DEFAULT 0`
- `allocation_ratio REAL NOT NULL`
- `allocation_method TEXT NOT NULL`
  - `exercise_count`, `completed_set_count`, or `equal_split`
- `created_at TEXT NOT NULL`

Unique constraint:

- unique on `(external_workout_id, workout_id)`

### 5. `health_daily_metrics`

Purpose:

- store imported Apple Health daily active and resting energy totals for nutrition features

Required columns:

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `date TEXT NOT NULL UNIQUE`
  - local calendar date in app/user timezone
- `source_type TEXT NOT NULL`
  - always `apple_health` in v1
- `active_energy_kj REAL`
- `resting_energy_kj REAL`
- `active_energy_kcal REAL`
- `resting_energy_kcal REAL`
- `tdee_kcal REAL`
  - derived at import time as `active_energy_kcal + resting_energy_kcal` when either value exists
- `sample_count_active INTEGER NOT NULL DEFAULT 0`
- `sample_count_resting INTEGER NOT NULL DEFAULT 0`
- `import_source_file TEXT NOT NULL`
- `imported_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

Indexes:

- unique index on `date`
- index on `updated_at`

## Import Levels

### Level 1: Summary only

This is the required v1.

Persist:

- external ID
- workout type
- name
- date
- start/end
- duration
- indoor/location flags
- active calories
- avg HR
- max HR
- min HR if present
- distance if present
- daily active energy totals
- daily resting energy totals
- daily TDEE summary (`resting + active`)

Do not persist raw arrays yet.

### Level 2: Summary + derived detail

Persist Level 1 plus:

- step count summary
- cadence summary
- intensity summary
- elevation up
- heart-rate recovery summary
- temperature/humidity summaries

This is optional after v1.

### Level 3: Full dataset

Persist Level 2 plus raw Apple arrays in `external_workout_raw`.

This is optional and should not block v1.

For daily energy metrics, v1 should still persist the aggregated per-date totals because macro tracking depends on them.

## Normalization Rules

The importer must normalize Apple records into a stable internal shape before matching or inserting.

Normalized shape:

```js
{
  sourceType: 'apple_health',
  externalId: 'UUID',
  workoutType: 'Functional Strength Training',
  name: 'Functional Strength Training',
  date: '2026-04-18',
  startAt: '2026-04-18T13:29:09+10:00',
  endAt: '2026-04-18T14:46:34+10:00',
  durationSeconds: 4644,
  isIndoor: true | false | null,
  locationLabel: 'Indoor' | null,
  summary: { ... },
  raw: { ... },
  sourceFile: 'HealthAutoExport-....json'
}
```

Normalized daily metric shape:

```js
{
  sourceType: 'apple_health',
  date: '2026-04-18',
  activeEnergyKj: 4184,
  restingEnergyKj: 7310,
  activeEnergyKcal: 1000,
  restingEnergyKcal: 1747.6,
  tdeeKcal: 2747.6,
  sampleCountActive: 24,
  sampleCountResting: 24,
  sourceFile: 'HealthAutoExport-....json'
}
```

Field mapping rules:

- `externalId = workout.id`
- `workoutType = workout.name.trim()`
- `name = workout.name.trim()`
- `startAt` and `endAt` derived from Apple `start` / `end`
- `date` derived from normalized local `startAt`
- `durationSeconds = Math.round(workout.duration)`
- `isIndoor = workout.isIndoor ?? (workout.location === 'Indoor' ? true : null)`
- `locationLabel = workout.location ?? null`

Metric extraction rules for Level 1:

- `active_energy_kcal = workout.activeEnergyBurned?.qty ?? null`
- `avg_heart_rate_bpm = workout.avgHeartRate?.qty ?? workout.heartRate?.avg ?? null`
- `max_heart_rate_bpm = workout.maxHeartRate?.qty ?? workout.heartRate?.max ?? null`
- `min_heart_rate_bpm = workout.heartRate?.min ?? null`
- `distance_meters = workout.distance?.qty ?? null`

Metric extraction rules for Level 2:

- `step_count_total`
  - sum of `stepCount[]` if array exists, else `null`
- `avg_step_cadence`
  - `stepCadence?.qty ?? null`
- `intensity_avg`
  - `intensity?.qty ?? null`
- `temperature_avg`
  - `temperature?.qty ?? null`
- `humidity_avg`
  - `humidity?.qty ?? null`
- `elevation_up_meters`
  - `elevationUp?.qty ?? null`
- `heart_rate_recovery_bpm`
  - derived summary, e.g. first HR recovery sample minus lowest value in first minute, if available

Daily metric normalization rules:

- only import metric rows where `type` is `active_energy` or `resting_energy`
- group samples by normalized local date
- sum all `active_energy` samples for a date into `active_energy_kj`
- sum all `resting_energy` samples for a date into `resting_energy_kj`
- convert kJ to kcal with `kcal = kJ / 4.184`
- round stored kcal values consistently to a practical precision such as 1 decimal place
- `tdee_kcal = coalesce(resting_energy_kcal, 0) + coalesce(active_energy_kcal, 0)`
- `sample_count_active` and `sample_count_resting` should reflect the number of source samples aggregated into each date row
- if only one of active/resting is present for a date, still upsert the row and leave the missing side as `null`

Example daily metric source assumptions to confirm in the export:

- metric sample timestamps can be normalized to a local calendar date
- sample values are exported in kJ
- multiple metric samples may exist per date and must be aggregated before upsert

## Import Classification Rules

For each normalized Apple workout:

1. If `durationSeconds < 300`
   - classify as `skipped_short_duration`
   - stop processing

2. Else if `workoutType === 'Functional Strength Training'`
   - import as external workout
   - attempt link matching to tracked workouts on the same date

3. Else
   - import as external workout
   - classify as `imported_standalone`
   - do not create tracked-workout links

Daily metric import classification rules:

1. For each file, parse `data.metrics[]`
2. Keep only `active_energy` and `resting_energy`
3. Group by local date
4. Aggregate totals and sample counts
5. Upsert one `health_daily_metrics` row per date

## Strength Matching Rules

### Matching input

For a given Apple `Functional Strength Training` workout:

- use the normalized local `date`
- fetch all tracked workouts from `workouts` for that date

Helper to use or add:

- `getWorkoutsForDate(date)` already exists in `database.js`

### Match outcome rules

If tracked workout count is:

- `0`
  - external workout row is created
  - `match_status = 'unmatched_strength'`
  - no link rows created

- `1`
  - external workout row is created/updated
  - create exactly one link row
  - `allocation_ratio = 1`
  - `allocation_method = 'equal_split'`
  - `match_status = 'matched_single'`

- `>1`
  - external workout row is created/updated
  - create one link row per tracked workout
  - compute allocation ratios
  - `match_status = 'matched_split'`

## Allocation Rules For Multi-Workout Days

When multiple tracked workouts exist on the same date for one Apple strength workout:

### Default allocation method

Use `exercise_count` first.

Weight definition:

- for each tracked workout, count non-skipped `workout_exercises`

If all counts are zero or unavailable:

- fallback to `completed_set_count`
  - count completed sets across all workout exercises for that workout

If still unusable:

- fallback to equal split

### Allocation output

For `n` linked tracked workouts:

- insert one `external_workout_links` row per linked workout
- store:
  - `link_order`
  - `allocation_ratio`
  - `allocation_method`

### Derived split values

Do **not** duplicate the Apple workout row.

Instead, derive per-tracked-workout display values from:

- external workout totals
- link allocation ratio

For example:

- 90-minute Apple strength workout
- two tracked workouts with ratios `0.67` and `0.33`
- display derived duration values of `60m` and `30m`

The original Apple totals always remain available on the canonical external workout row.

## Idempotency Rules

These are mandatory:

- external workout identity is `external_id`
- rerunning import must update, not duplicate
- links for an external workout must be replaced atomically on re-import
- metrics for an external workout must be replaced atomically on re-import
- raw-series rows for an external workout must be replaced atomically on re-import
- the import file name is stored for provenance only, not identity
- daily metric identity is `date`
- rerunning import must update the existing `health_daily_metrics` row for that date rather than inserting duplicates

## DB Helper Functions To Add

These helpers should be added to `database.js`:

- `upsertExternalWorkout(normalizedWorkout, importLevel)`
- `replaceExternalWorkoutMetrics(externalWorkoutId, metrics)`
- `replaceExternalWorkoutRaw(externalWorkoutId, rawMap)`
- `replaceExternalWorkoutLinks(externalWorkoutId, links)`
- `getTrackedWorkoutAllocationInputs(date)`
- `getExternalWorkoutByExternalId(externalId)`
- `getExternalWorkoutsByDate(date)`
- `getExternalWorkoutLinksForWorkout(workoutId)`
- `getUnmatchedExternalStrengthWorkouts()`
- `getMergedHistoryItems()`
- `upsertHealthDailyMetrics(metricRow)`
- `getHealthDailyMetricsByDate(date)`
- `getHealthDailyMetricsRange(startDate, endDate)`
- `getRecentHealthDailyMetrics(limit)`
- `getMacroTdeeContextForDate(date)`

## Import Script Design

Create a new script:

- `import-health.js`

It should support:

```bash
node import-health.js --dry-run
node import-health.js
node import-health.js --level=summary
node import-health.js --level=derived
node import-health.js --level=full
node import-health.js --min-duration=300
```

Default arguments:

- `level=summary`
- `min-duration=300`
- import every `.json` file under `data/HealthExport`

### Script flow

1. Discover files
2. Parse all `data.workouts[]`
3. Parse all `data.metrics[]`
4. Normalize workout records
5. Normalize and aggregate daily energy metrics by date
6. Filter out short-duration workouts
7. In dry-run mode:
   - compute workout classifications
   - compute daily metric aggregation counts
   - print counts and sample matches
8. In write mode:
   - run all inserts/updates inside transactions per workout or per file
   - upsert external workout
   - upsert workout metrics
   - upsert raw workout data if import level requires it
   - replace link rows if workout is a strength workout
   - upsert `health_daily_metrics` rows for aggregated daily energy totals

### Dry-run output requirements

Dry-run must report:

- files scanned
- workouts discovered
- `skipped_short_duration`
- `matched_single`
- `matched_split`
- `unmatched_strength`
- `imported_standalone`
- metric samples discovered
- metric dates aggregated
- metric dates upserted
- sample unmatched strength sessions
- sample multi-workout split cases
- sample daily energy totals

## API Additions

These routes should be added after the importer exists.

### Required routes

- `POST /api/import/health`
  - request body:
    - `dry_run`
    - `level`
    - `min_duration_seconds`
- `GET /api/import/health/status`
  - counts by match/import state
- `GET /api/import/health/unmatched`
  - list unmatched strength sessions
- `GET /api/workouts/:id/external-links`
  - linked Apple workouts for one tracked workout
- `GET /api/external-workouts`
  - standalone or all external workouts
- `GET /api/external-workouts/:id`
  - detail for one external workout
- `GET /api/health/daily-metrics/:date`
  - active/resting energy and TDEE context for one date
- `GET /api/health/daily-metrics`
  - optional range query for nutrition graphs or summaries

### Response shape defaults

For `GET /api/workouts/:id/external-links`, return:

```json
[
  {
    "external_workout_id": 12,
    "external_id": "UUID",
    "workout_type": "Functional Strength Training",
    "start_at": "...",
    "end_at": "...",
    "duration_seconds": 4644,
    "allocation_ratio": 0.5,
    "allocation_method": "exercise_count",
    "derived_summary": {
      "duration_seconds": 2322,
      "active_energy_kcal": 210.5
    },
    "full_summary": {
      "duration_seconds": 4644,
      "active_energy_kcal": 421
    }
  }
]
```

## Frontend Integration Rules

### History

History should become a merged timeline of:

- tracked workouts
- standalone external workouts

Tracked workouts may also show linked Apple strength summaries.

Display rules:

- tracked workouts remain the primary card type
- if linked Apple strength data exists, show a compact `Apple Watch` summary block
- standalone external workouts use a different card type with:
  - workout type
  - start/end or duration
  - summary metrics

### Progress

In v1:

- do **not** include external workouts in strength progression charts
- do **not** use external data to alter `getExerciseTrend`
- leave bodyweight behavior unchanged

For workout frequency:

- v1 recommendation: keep existing workout frequency based only on tracked workouts
- optional later enhancement: add a toggle for `Tracked only` vs `All workouts`

### Nutrition / Macro Tracking

The Nutrition tab should be able to use imported daily Apple Health metrics for TDEE context.

Display and data rules:

- macro logging remains independent from Apple Health import
- imported `health_daily_metrics` should supply day-level:
  - `active_energy_kcal`
  - `resting_energy_kcal`
  - `tdee_kcal`
- nutrition views may use these values to compare logged calories vs estimated expenditure
- this should use daily totals, not workout-session active calories, because macro/TDEE context is day-based
- if a date has no imported Apple energy row, nutrition should fall back to existing non-Apple behavior until macro-plan fallback logic is implemented

### Export

`/api/export/json` must include:

- `external_workouts`
- `external_workout_metrics`
- `external_workout_links`
- `external_workout_raw` if implemented
- `health_daily_metrics`

## Existing Queries That Need Extension

The following existing backend/frontend areas will need updates:

- `getAllWorkoutDates()`
  - currently only returns tracked workouts
  - add a merged history query for tracked + standalone external workouts

- `getAllWorkoutSessionDates()`
  - currently only uses tracked workouts
  - leave unchanged in v1 unless workout frequency is deliberately broadened

- `/api/history`
  - should return merged items if the History tab is meant to show imported non-strength workouts

- `/api/export/json`
  - add new external tables

- nutrition/day context queries
  - extend them to optionally join or fetch `health_daily_metrics` by date

## Status Buckets

These statuses are final and should be used consistently:

- `matched_single`
- `matched_split`
- `unmatched_strength`
- `imported_standalone`
- `skipped_short_duration`

## Acceptance Criteria

The first acceptable implementation is complete when:

- every Apple workout under 5 minutes is skipped
- every Apple workout 5 minutes or longer is imported or explicitly classified
- all `Functional Strength Training` workouts are either linked or marked unmatched
- all non-strength Apple workouts are imported as standalone external workouts
- repeated imports do not create duplicates
- same-date multi-workout tracked days correctly create multiple link rows for one Apple strength workout
- History can display standalone imported workouts
- tracked workouts can display linked Apple strength summaries
- daily Apple active/resting energy totals are imported idempotently by date
- nutrition/macro features can read daily Apple energy totals for TDEE context
- JSON export includes the external workout tables

## Review Next Steps

The main next-step review items are:

- verify the upload flow on iOS Safari, which is the primary target environment
- verify the custom file picker and automatic preview flow on mobile Safari specifically
- confirm the upload modal remains usable with large 90-day JSON exports on-device
- review whether a previously imported partial current-day energy row needs one-off cleanup in the copied/live DB
- review whether same-snapshot-date overwrite behavior is the desired final policy for corrected re-exports
- review whether upload archives under `data/health-import-uploads/` need retention or cleanup rules
- decide whether standalone Apple workouts in History need richer visual treatment beyond the current basic detail view
- review whether imported Apple workout detail needs richer metrics/charts beyond the current summary presentation
- decide whether the raw JSON file reference currently stored in `external_workout_raw` should remain there or be renamed/documented more explicitly as a file-reference table pattern
- update `README.md` with the user-facing Apple Health import workflow once the upload UX is considered stable

## Implementation Order

### Phase 1

Add schema migrations in `database.js` for:

- `external_workouts`
- `external_workout_metrics`
- `external_workout_links`
- `external_workout_raw` (optional now, but recommended to add early if you want Level 3 later)
- `health_daily_metrics`

### Phase 2

Add DB helpers in `database.js`.

### Phase 3

Create `import-health.js` with:

- file scanning
- normalization
- 5-minute filter
- dry-run mode
- Level 1 summary import
- daily active/resting energy aggregation and upsert

### Phase 4

Implement strength matching and link allocation.

### Phase 5

Add API routes for import status, linked external workout retrieval, and daily health metric retrieval.

### Phase 6

Update History UI to show:

- standalone external workouts
- linked Apple strength summaries on tracked workouts

### Phase 7

Update `/api/export/json` and nutrition day-context reads.

### Phase 8

Optionally add Level 2 / Level 3 import depth and richer visualizations.

## Files Expected To Change

- `database.js`
- `server.js`
- new file: `import-health.js`
- `public/js/features/history.js`
- `public/js/features/progress/index.js`
- `public/js/features/nutrition/*`
- `README.md`

## Notes For A Fresh Codex Session

If starting implementation from this document:

1. Read `database.js` first to understand current tracked workout schema
2. Read `server.js` to see current history/export endpoints
3. Inspect `data/HealthExport/*.json` and confirm the field shape still matches what is documented here
4. Confirm both `data.workouts[]` and `data.metrics[]` are present and that energy metric units are still kJ
5. Implement backend schema and dry-run import before touching frontend
6. Do not change the meaning of the existing `workouts` table
7. Keep Level 1 import as the scope boundary for the first pass, but include daily energy import because the macro plan depends on it

This document is intended to be sufficient for that session to proceed directly into implementation.
