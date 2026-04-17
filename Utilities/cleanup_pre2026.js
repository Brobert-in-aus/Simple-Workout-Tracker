const Database = require('better-sqlite3');
const path = require('path');

const cutoff = '2026-01-01';
const apply = process.argv.includes('--apply');
const dbPath = path.join(__dirname, '..', 'data', 'workouts.db');
const db = new Database(dbPath);

db.pragma('foreign_keys = ON');

function getSummary() {
  const workouts = db.prepare(`
    SELECT COUNT(*) AS count
    FROM workouts
    WHERE date < ?
  `).get(cutoff).count;

  const workoutExercises = db.prepare(`
    SELECT COUNT(*) AS count
    FROM workout_exercises we
    JOIN workouts w ON w.id = we.workout_id
    WHERE w.date < ?
  `).get(cutoff).count;

  const workoutSets = db.prepare(`
    SELECT COUNT(*) AS count
    FROM workout_sets ws
    JOIN workout_exercises we ON we.id = ws.workout_exercise_id
    JOIN workouts w ON w.id = we.workout_id
    WHERE w.date < ?
  `).get(cutoff).count;

  const bodyWeights = db.prepare(`
    SELECT COUNT(*) AS count
    FROM body_weights
    WHERE date < ?
  `).get(cutoff).count;

  return { workouts, workoutExercises, workoutSets, bodyWeights };
}

try {
  const before = getSummary();

  console.log(`Cleanup target: records before ${cutoff}`);
  console.log(`  Workouts:           ${before.workouts}`);
  console.log(`  Workout exercises:  ${before.workoutExercises}`);
  console.log(`  Workout sets:       ${before.workoutSets}`);
  console.log(`  Bodyweight entries: ${before.bodyWeights}`);

  if (!apply) {
    console.log('');
    console.log('Dry run only. Re-run with --apply to delete these records.');
    process.exit(0);
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM body_weights WHERE date < ?').run(cutoff);
    db.prepare('DELETE FROM workouts WHERE date < ?').run(cutoff);
  });

  tx();

  const after = getSummary();
  console.log('');
  console.log('Cleanup complete.');
  console.log(`  Remaining pre-2026 workouts:           ${after.workouts}`);
  console.log(`  Remaining pre-2026 workout exercises:  ${after.workoutExercises}`);
  console.log(`  Remaining pre-2026 workout sets:       ${after.workoutSets}`);
  console.log(`  Remaining pre-2026 bodyweight entries: ${after.bodyWeights}`);
} finally {
  db.close();
}
