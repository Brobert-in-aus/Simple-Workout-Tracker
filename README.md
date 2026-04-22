# Simple Workout Tracker

A small, self-hosted workout tracker built with Node.js, SQLite, and vanilla HTML/CSS/JS.

It is designed for personal use on a local machine or LAN: no accounts, no cloud dependency, no build step, and no framework lock-in. You can run it on a desktop, mini-PC, or laptop and log workouts from any device on the same network.

## What It Does

The app has four tabs:

- **Workout** — log sessions for the current day and week
- **Templates** — manage exercise templates and the weekly schedule
- **Progress** — body weight charts, strength trends, workout frequency, and history
- **Nutrition** — meal template logging with calorie and protein targets

## Current Features

### Workout logging

- Weekly schedule with multiple templates assignable to the same day
- Current-week strip showing actual completed workouts for past days and scheduled workouts for today / future
- One-tap `Today` jump in week navigation
- Begin a scheduled workout from a preview
- Smart pre-fill from the most recent relevant session, including across different templates
- Warmup sets kept separate from working sets — no cross-contamination on pre-fill or weight matching
- Per-set logging for:
  - weight and reps
  - timed / duration-based exercises
  - AMRAP sets, including last-set-only AMRAP
- Warmup exercise support with visual badge
- Superset and giant-set grouping
- Skip / unskip per exercise
- Swap an exercise for an alternative during a workout
- Reorder exercises within an active workout
- Add ad-hoc exercises to an active workout
- Add / remove sets during a workout
- `Done All` action for quickly marking every set complete
- Bulk weight copy and auto-match behavior for multi-set exercises
- Notes on workout exercises, with previous-session note shown as placeholder
- Double-tap the Workout tab to jump to the first unfinished exercise

### Templates and schedule

- Create, rename, duplicate, and delete templates
- Assign and remove templates from weekdays
- Exercise library with reusable exercise names and autocomplete
- Inline editing of template exercise name, sets, reps, and note
- Warmup, duration, and AMRAP flags in templates
- Reorder template exercises
- Build supersets / giant sets in templates
- Cross-template exercise linking:
  - shared exercises stay synced across templates by default
  - targets can be broken out to be independent per template when needed
- Soft-delete template exercises while preserving workout history
- Restore previously deleted exercises
- Permanently purge archived exercises when you want the history removed too

### Progress and history

- **Body** — bodyweight logging with today's card, editable history, and a line chart
- **Strength** — searchable exercise picker with favorite pinning; volume trend chart (kg × reps) and set-completion trend chart per session
- **Workouts** — sessions per week bar chart, total session count, weeks trained, average sessions per week, and inline weekly session detail
- **History** — full workout history with per-exercise progression modal
- Expandable charts that open in a larger modal view

### Nutrition

- Day view with date navigation and a `Today` jump
- Meal templates define what you eat regularly — each template can be set to **quick-confirm** (one tap logs the default values) or manual entry
- Separate calorie and protein targets for **Training Days** and **Rest Days**
- Deficit target with a visual ±100 kcal / ±15 g protein range indicator
- TDEE integration: if Apple Health data is present, an active-energy adjustment factor scales the resting energy baseline to produce a realistic daily TDEE
- Summary views at 1, 3, 6 months, and all-time — energy balance trend, calories logged, and active energy (from Apple Health)

### Apple Health import

- Upload an Apple Health export JSON file through the app UI, or run `npm run import:health` against a local file
- Dry-run mode shows exactly what would be added or changed before committing
- Imports daily metrics: active energy, resting energy (converted to TDEE), step count, and more
- Imports Apple Fitness workouts with heart rate, distance, cadence, intensity, elevation, and other metadata
- Automatically matches *Functional Strength Training* workouts to your logged sessions, with single or proportional allocation when multiple templates were trained on the same day
- Re-importing a newer export file skips records where the stored values are identical — only genuine changes are counted as updates

### Reliability and maintenance

- SQLite with schema and migration logic in code — no manual database setup
- Weekly backup visibility in the launcher and in the app
- JSON export endpoint for a full data snapshot
- Graceful shutdown endpoint used by the Windows launcher
- Lightweight backend smoke tests with Node's built-in test runner
- Native browser ES modules on the frontend, with no bundler

## Quick Start

### Windows portable setup

1. Clone or download this repository.
2. Run `setup.bat` once.
   It downloads portable Node.js into `runtime\` and installs production dependencies.
3. Run `start.bat`.
4. Open `http://localhost:3000` in your browser.

`start.bat` also:

- prints local and LAN URLs
- shows the latest weekly backup filename, if one exists
- supports restart, update, and quit commands

To use the app from your phone or tablet, open the LAN URL shown in the launcher output.

### Any OS with Node.js installed

Requires Node.js 18+.

```bash
npm install --production
npm start
```

The server listens on port `3000` by default. Set `PORT` to override it.

## Useful Commands

```bash
npm start
npm test
npm run import
npm run import:health
```

- `npm start` — runs the Express server
- `npm test` — runs the lightweight backend smoke tests in `test/db.test.js`
- `npm run import` — parses legacy text workout history from `Workout History/`
- `npm run import:health` — imports Apple Health export data (pass `--dry-run` to preview)

## Project Structure

```text
server.js                 Express API server
database.js               SQLite schema, migrations, and DB helpers
backup.js                 Backup helper used by the launcher / update flow
import.js                 Legacy workout history import script
import-health.js          Apple Health export import script
public/
  index.html              App shell
  app.js                  Frontend bootstrap entrypoint
  style.css               Styles
  js/
    core/                 Shared frontend helpers and app state
    features/             Frontend feature modules
      navigation.js       Tab + week navigation wiring
      workout.js          Workout tab behavior
      template.js         Template / schedule editor behavior
      history.js          History and progression modal behavior
      nutrition.js        Nutrition tab behavior
      progress/
        index.js          Progress tab sections
        charts.js         SVG chart helpers
data/                     SQLite DB, logs, backups, exports created at runtime
runtime/                  Portable Node.js on Windows after setup.bat
test/
  db.test.js              Lightweight backend smoke tests
setup.bat                 Windows portable setup
start.bat                 Windows launcher
package.json
```

## API Overview

The frontend talks to a local Express API for:

- templates and schedule management
- workout creation and editing
- history and trend data
- bodyweight logging
- nutrition template and log management
- Apple Health data ingest and metric storage
- backup status
- JSON export
- graceful shutdown

The API is intentionally private to this app and not meant as a public integration surface.

## Data and Backups

- Main database: `data/workouts.db`
- Backups: `data/backups/`
- Server log: `data/server-log.txt`
- Apple Health raw data: `data/health-raw/` (created by import)

If you want to preserve everything, back up the whole `data/` directory.

## Testing

The repo includes lightweight backend coverage for the highest-value database flows:

- workout creation from templates
- pre-fill behavior (including warmup / working-set separation)
- ad-hoc workout exercise insertion
- exercise swapping
- trend aggregation
- performed-exercise filtering
- duplicate-template naming
- bodyweight insert / upsert / delete behavior

This is not a full UI regression suite, so manual smoke checks are still useful after frontend refactors.

## Design Goals

- Single-user and personal-use first
- Small, local-first, and easy to maintain
- No build step unless it clearly earns its keep
- Maintainability over cleverness
- No accounts, cloud sync, or heavyweight analytics
