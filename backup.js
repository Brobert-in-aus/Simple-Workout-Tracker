// Standalone backup utility — called from start.bat before a git pull.
// Uses SQLite's online backup API so WAL data is included even if the server
// was hard-killed and the WAL wasn't checkpointed.
// Usage: node backup.js [label]   (label defaults to "manual")
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const label = process.argv[2] || 'manual';
const now = new Date();
const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

const backupDir = path.join(__dirname, 'data', 'backups');
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

const dest = path.join(backupDir, `workouts-${label}-${ts}.db`);
const db = new Database(path.join(__dirname, 'data', 'workouts.db'));
db.backup(dest)
  .then(() => { console.log(`  Backup saved: ${dest}`); db.close(); })
  .catch(err => { console.error(`  Backup failed: ${err.message}`); db.close(); process.exit(1); });
