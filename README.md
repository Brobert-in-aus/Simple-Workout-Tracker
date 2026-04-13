# Simple Workout Tracker

A portable, self-hosted workout tracker built with Node.js and vanilla HTML/CSS/JS. Designed to run on a local network so you can log workouts from any device (phone, tablet, PC).

## Features

- **Weekly schedule** with customizable workout templates (Push, Pull, Legs, etc.)
- **Exercise library** with auto-complete and reusable exercise definitions
- **Cross-template exercise linking** — exercises shared across templates stay in sync (sets, reps, flags, notes)
- **Smart pre-fill** — new workouts auto-fill from your most recent session, even across different templates
- **Bulk weight update** — change one set's weight and all uniform sets update together, plus a "Weight ↓" button to copy the first set's weight to all others
- **Superset grouping** — visually group exercises that are performed together
- **Exercise flags** — mark exercises as warmup, duration-based (timed), or AMRAP
- **Per-set tracking** — log weight, reps, and duration for every set
- **Workout history** — browse past sessions with full set-by-set detail
- **Exercise history** — view recent performance trends per exercise
- **Quick-navigate** — double-tap the Workout tab to jump to your lowest uncompleted exercise
- **Portable** — runs entirely from a single folder with no system-wide install required

## Quick Start (Windows)

1. **Download or clone** this repository
2. **Run `setup.bat`** — downloads a portable Node.js and installs dependencies (internet required once)
3. **Run `start.bat`** — starts the server and shows your local + LAN URLs
4. **Open** `http://localhost:3000` in a browser

To use from your phone or other devices, open the LAN URL shown in the terminal (e.g. `http://192.168.1.x:3000`).

## Quick Start (Any OS)

Requires [Node.js](https://nodejs.org/) v18+ installed on your system.

```bash
npm install --production
node server.js
```

The server starts on port 3000 by default (override with `PORT` environment variable).

## Project Structure

```
├── server.js          # Express API server
├── database.js        # SQLite schema, migrations, and DB helpers
├── public/
│   ├── index.html     # Single-page app shell
│   ├── app.js         # Frontend logic (vanilla JS)
│   └── style.css      # Styles
├── data/              # SQLite database (auto-created on first run)
├── setup.bat          # Windows portable setup (downloads Node.js + deps)
├── start.bat          # Windows launcher with restart/quit controls
└── package.json
```

## Tech Stack

- **Backend:** Node.js, Express, better-sqlite3
- **Frontend:** Vanilla HTML, CSS, JavaScript (no build step, no frameworks)
- **Database:** SQLite with WAL mode

## Deployment

The entire folder is self-contained. After running `setup.bat` once on a machine with internet:

1. Copy the entire folder to your target machine (e.g. a mini-PC)
2. Double-click `start.bat` to launch
3. Access from any device on the same network

Data is stored in `data/workouts.db`. Back up this file to preserve your workout history.
