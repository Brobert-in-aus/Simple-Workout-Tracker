# Simple Workout Tracker

A small, self-hosted workout tracker built with Node.js, SQLite, and vanilla HTML/CSS/JS.

It is designed for personal use on a local machine or LAN: no accounts, no cloud dependency, no build step, and no framework lock-in. You can run it on a desktop, mini-PC, or laptop and log workouts from any device on the same network.

## What It Does

The app combines four main areas:

- Workout logging for the current day and week
- Template and schedule editing
- Progress views for bodyweight, strength, and training frequency
- History browsing with per-exercise progression detail

## Current Features

### Workout logging

- Weekly schedule with multiple templates assignable to the same day
- Current-week strip with actual completed workouts for past days and scheduled workouts for today/future days
- One-tap `Today` jump in week navigation
- Begin a scheduled workout from a preview
- Smart pre-fill from the most recent relevant session, including across different templates
- Per-set logging for:
  - weight and reps
  - timed / duration-based exercises
  - AMRAP sets, including last-set-only AMRAP
- Warmup exercise support
- Superset and giant-set grouping
- Skip / unskip per exercise
- Swap an exercise for an alternative during a workout
- Reorder exercises within an active workout
- Add ad-hoc exercises to an active workout
- Add / remove sets during a workout
- `Done All` action for quickly marking every set complete
- Bulk weight copy / auto-match behavior for multi-set exercises
- Notes on workout exercises, plus previous-note context
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
  - shared exercises can stay synced across templates
  - targets can be broken out to be independent when needed
- Soft-delete template exercises while preserving workout history
- Restore previously deleted exercises
- Permanently purge archived exercises when you really want the history removed

### Progress and history

- Progress tab with four sections:
  - Body
  - Strength
  - Workouts
  - History
- Bodyweight logging with:
  - today's weight card
  - editable history
  - line chart
  - empty / low-data states
- Strength progression with:
  - searchable exercise picker
  - favorite / pinned exercises
  - volume trend chart
  - set-completion trend chart
- Workout frequency view with:
  - sessions per week bar chart
  - sessions count
  - weeks trained
  - average sessions per week
  - inline weekly session detail
- Full workout history browsing
- Per-exercise progression modal from history entries
- Expandable charts that open in a larger modal view

### Reliability and maintenance

- SQLite with schema/migration logic in code
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
```

- `npm start` runs the Express server
- `npm test` runs the lightweight backend smoke tests in `test/db.test.js`
- `npm run import` runs `import.js`

## Project Structure

```text
server.js                 Express API server
database.js               SQLite schema, migrations, and DB helpers
backup.js                 Backup helper used by the launcher/update flow
import.js                 Data import script
public/
  index.html              App shell
  app.js                  Frontend bootstrap entrypoint
  style.css               Styles
  js/
    core/                 Shared frontend helpers and app state
    features/             Frontend feature modules
      navigation.js       Tab + week navigation wiring
      workout.js          Workout tab behavior
      template.js         Template/schedule editor behavior
      history.js          History and progression modal behavior
      progress/
        index.js          Progress sections
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
- backup status
- JSON export
- graceful shutdown

The API is intentionally private to this app and not meant as a public integration surface.

## Data and Backups

- Main database: `data/workouts.db`
- Backups: `data/backups/`
- Server log: `data/server-log.txt`

If you want to preserve everything, back up the whole `data/` directory.

## Testing

The repo currently includes lightweight backend coverage for the highest-value database flows, including:

- workout creation from templates
- pre-fill behavior
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
