# Macro Tracking Plan

## Purpose

Design and implementation notes for the Nutrition tab: macro tracking, meal templating, and Apple Health-backed TDEE context.

---

## Current State - Fully Implemented

### What was built

- **Nutrition tab** (4th nav tab) with sticky date navigation
- **Nutrition Summary view** with `1m / 3m / 6m / all` range controls, topline stats, trend charts, and recent active-day rows
- **Day type detection** - past dates use recorded workouts; current and future dates use the weekly schedule so planned training days do not show as rest days before a workout is started
- **Meal template slots** - ordered list of named slots managed via the Meal Settings modal
- **Per-slot rest-day toggle** - `include_rest_day` flag hides slots on rest days
- **Per-slot quick-confirm toggle** (`use_defaults`) - see Option B below
- **Inline macro logging** - tap card header to expand; Calories + Protein inputs; 500ms debounced auto-save
- **Unlogged vs logged state** - unlogged slots show dimmed defaults or blank `-`; logged slots show actuals
- **Delete / reset** - `x` on a template slot resets it to unlogged; `x` on a custom meal removes it entirely
- **Custom meal entry** - `+ Add Custom Meal`, prompts for name, creates a row immediately
- **Two-profile macro targets** - Training Day and Rest Day targets, set in Meal Settings
- **Separate progress bars** - individual Calories and Protein bars with color-coded range indicators
- **Target range indicators** - hardcoded +/-100 kcal / +/-15 g protein; `target-hit` (green) / `target-low` (olive) / `target-high` (dark red) applied to bars and daily totals
- **Daily total** - Calories and Protein vs targets; Apple Health resting/active/TDEE rows; signed deficit/surplus progress row when TDEE data is available
- **Signed energy target field** - per-profile target supports:
  - negative value = deficit target
  - positive value = surplus target
- **Dynamic energy target labeling** - settings field label changes between `Deficit`, `Surplus`, and `Deficit/Surplus`
- **Wrong-side clamping in totals** - if the user is on the wrong side of maintenance, the main target row shows `0 / target` and the opposite-side note inline
- **Sticky modal header** - title + close button remain fixed while settings content scrolls

### What is tracked vs hidden

| Field | DB / API | Inputs | Summary | Target bar | Daily total |
|-------|----------|--------|---------|------------|-------------|
| Calories | Yes | Yes | Yes | Yes | Yes |
| Protein | Yes | Yes | Yes | Yes | Yes |
| Carbs | Yes | No | No | No | No |
| Fat | Yes | No | No | No | No |

Carbs and fat are stored in the DB and sent through the API unchanged; they are simply not rendered anywhere in the UI. Re-exposing them requires no schema or API changes.

### Schema

```sql
CREATE TABLE meal_templates (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  calories_kcal    REAL    NOT NULL DEFAULT 0,
  protein_g        REAL    NOT NULL DEFAULT 0,
  carbs_g          REAL    NOT NULL DEFAULT 0,  -- stored, hidden from UI
  fat_g            REAL    NOT NULL DEFAULT 0,  -- stored, hidden from UI
  include_rest_day INTEGER NOT NULL DEFAULT 1,
  use_defaults     INTEGER NOT NULL DEFAULT 0,  -- Option B: quick-confirm toggle
  active           INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE macro_logs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  date             TEXT    NOT NULL,
  meal_template_id INTEGER REFERENCES meal_templates(id) ON DELETE SET NULL,
  meal_name        TEXT    NOT NULL,  -- snapshot at log time
  sort_order       INTEGER NOT NULL DEFAULT 0,
  calories_kcal    REAL    NOT NULL DEFAULT 0,
  protein_g        REAL    NOT NULL DEFAULT 0,
  carbs_g          REAL    NOT NULL DEFAULT 0,  -- stored, hidden from UI
  fat_g            REAL    NOT NULL DEFAULT 0   -- stored, hidden from UI
);

CREATE TABLE user_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Keys used:
--   macro_targets_workout  JSON: { calories, protein_g, carbs_g, fat_g, energy_target }
--   macro_targets_rest     JSON: { calories, protein_g, carbs_g, fat_g, energy_target }
```

### API

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/nutrition/templates` | List active templates |
| POST | `/api/nutrition/templates` | Create template |
| PUT | `/api/nutrition/templates/reorder` | Reorder (order array) |
| PUT | `/api/nutrition/templates/:id` | Update fields |
| DELETE | `/api/nutrition/templates/:id` | Soft-delete (active = 0) |
| GET | `/api/nutrition/logs/:date` | Day's logs + `is_workout_day` + `tdee_kcal` + `health_metrics` |
| GET | `/api/nutrition/summary?range=1m|3m|6m|all` | Range summary with daily points, averages, target-hit counts, and Apple/fallback source flags |
| POST | `/api/nutrition/logs` | Create log entry (upserts on `meal_template_id + date`) |
| PUT | `/api/nutrition/logs/:id` | Update log entry |
| DELETE | `/api/nutrition/logs/:id` | Delete log entry |
| GET | `/api/nutrition/targets` | Get both target profiles |
| PUT | `/api/nutrition/targets` | Save both target profiles |

### Decisions made

- **Per-meal per-day logging, not daily totals** - gives meal-level visibility without requiring a food database
- **Template snapshot at log time** - `meal_name` copied from template when the row is created; renames do not affect history
- **Rest-day exclusion is per-slot** - avoids duplicating the template; just flag which slots to hide
- **Macro targets are two static profiles** - Training Day and Rest Day; detection from the `workouts` table
- **Carbs and fat hidden, not deleted** - UI shows only calories and protein; DB columns kept so the decision is reversible without a migration
- **No fiber, sodium, or micronutrients** - manual entry only, no external food database
- **Target range constants hardcoded** - `CAL_RANGE = 100`, `PROT_RANGE = 15`; not user-configurable
- **Upsert on template log POST** - if `(meal_template_id, date)` already exists, update and return the existing row rather than inserting a duplicate
- **Save handler uses `updateTotalsDisplay()`** - not `renderContent()`; avoids re-rendering from stale `logData` which would wipe in-session logged state and allow duplicate confirms
- **Energy balance is stored/displayed as signed logic with guided presentation** - actual balance remains `logged_kcal - TDEE`, but target progress is presented to match the chosen deficit/surplus direction

---

## Meal Template Redesign - Option B (Implemented)

### Problem

The original system pre-filled every slot with default macros, which caused friction for variable meals (Lunch, Dinner) that always needed manual replacement. Three behaviors are needed:

- **Consistent meals** (Breakfast, Shake): one tap to confirm "I had this today"
- **Variable meals** (Lunch, Dinner): start blank, enter fresh values every time
- **Skip** a slot entirely on days when it was not eaten

### Option A - Two-layer: meal presets + meal slots (not chosen)

Separate `meal_presets` table from the `meal_templates`/slots table. Each slot optionally references a preset via `preset_id`.

**Verdict:** Right answer if the same preset needs to appear in multiple slots. Otherwise overkill. The `getSlotDefaults(template)` helper in the frontend is the designated migration point - in an Option A world it would resolve `template.preset_id` to the preset's macros instead of using the slot's own values.

---

### Option B - `use_defaults` toggle per slot (Implemented)

One column added: `use_defaults INTEGER NOT NULL DEFAULT 0`.

- **`use_defaults = 1` (quick-confirm):** collapsed card shows dimmed defaults + a check button. Tapping it logs the slot with template defaults in one tap, no expansion needed. Tapping the confirmed button expands to edit.
- **`use_defaults = 0` (manual entry):** collapsed card shows `-`. Tap anywhere to expand and enter.
- **Skip:** the delete button removes the day's log entry and resets the card to its unlogged state.

---

### Option C - Implicit: zero macros = blank (not chosen)

Treat slots where all macro fields are 0 as manual entry. Fragile: cannot distinguish "no default" from "fasted today (0 kcal)".

---

## Phase 2 - TDEE and Apple Health

Apple Health TDEE context is now live in the app.

### What's built

- `health_daily_metrics` table and related DB helpers now exist in `database.js`
- Apple Health uploads import daily active/resting energy from `data.metrics[]`, aggregate by date, and upsert idempotently
- the latest metric date in each uploaded snapshot is skipped so incomplete same-day energy is not imported
- imported rows track `source_snapshot_date`, so newer snapshots overwrite older rows and stale snapshots do not clobber newer data
- `GET /api/nutrition/logs/:date` includes both `tdee_kcal` and `health_metrics`
- Nutrition daily totals now show:
  - resting energy
  - active energy
  - TDEE
  - deficit/surplus progress when TDEE is available
- the per-profile energy target field now supports signed targets:
  - negative value = deficit target
  - positive value = surplus target
- the stored settings key is now `energy_target`, with backward-compatible reading of older saved `deficit_target` values
- the settings UI now labels that field dynamically as `Deficit`, `Surplus`, or `Deficit/Surplus`
- the totals card clamps progress to `0` when the user is on the wrong side of maintenance and shows the opposite-side note inline, for example `Deficit 0 / 600 kcal (300 kcal surplus)`
- energy target status colors now use the app palette and the existing hardcoded calorie tolerance:
  - green when within +/-100 kcal of target on the correct side
  - olive when on the correct side but outside tolerance
  - dark red when on the wrong side entirely
- when Apple data is missing for a date, Nutrition now falls back to recent Apple history:
  - last 14 same day-type rows first
  - if fewer than 3 same day-type rows exist, last 14 Apple days overall
- the totals UI now indicates when TDEE is estimated from fallback history instead of a direct same-day Apple import
- Nutrition now has a Summary mode that:
  - requests range-based summary data from `/api/nutrition/summary`
  - shows average intake, protein, energy balance, and Apple Health coverage
  - charts energy balance, calories logged, and active energy over time
  - shows recent active days with workout/rest classification plus direct vs estimated Apple context
  - counts calorie/protein/energy target-hit days across the selected range

### What's still needed

- No remaining must-build items on the original macro plan.
- Future polish, if wanted later:
  - richer chart comparisons such as intake vs TDEE on the same plot
  - export/share for nutrition summaries
  - weekly/monthly rollups if the daily summary view starts feeling too granular for long ranges
