// Lightweight smoke tests for the DB layer.
// Uses Node's built-in node:test; no extra dependencies.
// Covers the failure-prone paths the Personal Improvements Plan calls out:
// workout creation, ad-hoc exercises, exercise swaps, trend aggregation,
// and bodyweight helpers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the DB at a disposable location BEFORE requiring database.js so the
// singleton opens the test database rather than the user's real one.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-smoke-'));
process.env.WORKOUT_DB_PATH = path.join(tmpDir, 'test.db');

const db = require('../database');
db.getDb(); // initialise schema

test.after(() => {
  db.closeDb();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

// --- Helpers ---------------------------------------------------------------

function buildTemplate(templateName, exerciseSpecs) {
  const templateId = db.createTemplate(templateName);
  const deIds = [];
  exerciseSpecs.forEach((spec, idx) => {
    const exerciseId = db.getOrCreateExercise(spec.name);
    const id = db.addDayExercise(
      templateId,
      exerciseId,
      spec.targetSets ?? 3,
      spec.targetReps ?? '10',
      idx,
      spec.notes || null,
      spec.supersetGroup || null,
      !!spec.isWarmup,
      !!spec.isDuration,
      !!spec.isAmrap,
      !!spec.amrapLastOnly
    );
    deIds.push(id);
  });
  return { templateId, deIds };
}

// --- Workout creation ------------------------------------------------------

test('initWorkoutFromTemplate creates workout, exercises, and sets from template', () => {
  const { templateId } = buildTemplate('Smoke-Push', [
    { name: 'Smoke Bench Press', targetSets: 3, targetReps: '8' },
    { name: 'Smoke Overhead Press', targetSets: 2, targetReps: '10' },
  ]);

  const date = '2026-01-05';
  const workout = db.initWorkoutFromTemplate(date, templateId);
  assert.ok(workout.id, 'workout should have an id');

  const full = db.getWorkoutFull(workout.id);
  assert.equal(full.length, 2, 'expected two exercises');
  assert.equal(full[0].exercise_name, 'Smoke Bench Press');
  assert.equal(full[0].sets.length, 3);
  assert.equal(full[1].sets.length, 2);
  // First session -> no prior data -> reps default to parsed target_reps
  assert.equal(full[0].sets[0].target_reps, 8);
  assert.equal(full[0].sets[0].reps, 8);

  // Idempotent: calling again for the same date/template should not duplicate.
  db.initWorkoutFromTemplate(date, templateId);
  const after = db.getWorkoutFull(workout.id);
  assert.equal(after.length, 2, 'second init must not add exercises');
});

test('initWorkoutFromTemplate pre-fills from most recent session', () => {
  const { templateId } = buildTemplate('Smoke-Legs', [
    { name: 'Smoke Squat', targetSets: 3, targetReps: '5' },
  ]);

  // Previous session
  const prev = db.initWorkoutFromTemplate('2026-02-01', templateId);
  const prevFull = db.getWorkoutFull(prev.id);
  const prevWeId = prevFull[0].id;
  db.saveWorkoutExercise(prevWeId, [
    { weight: 100, reps: 5, target_reps: 5, completed: 1 },
    { weight: 100, reps: 5, target_reps: 5, completed: 1 },
    { weight: 100, reps: 4, target_reps: 5, completed: 1 },
  ]);

  // New session — should carry weights/reps from prev
  const next = db.initWorkoutFromTemplate('2026-02-04', templateId);
  const nextFull = db.getWorkoutFull(next.id);
  assert.equal(nextFull[0].sets[0].weight, 100);
  assert.equal(nextFull[0].sets[0].reps, 5);
  assert.equal(nextFull[0].sets[2].reps, 4, 'third set should carry reps from previous session');
});

// --- Ad-hoc exercise additions --------------------------------------------

test('addExerciseToWorkout inserts at requested position and shifts sort_order', () => {
  const { templateId } = buildTemplate('Smoke-Pull', [
    { name: 'Smoke Row', targetSets: 3, targetReps: '10' },
    { name: 'Smoke Pullup', targetSets: 3, targetReps: '8' },
  ]);

  const workout = db.initWorkoutFromTemplate('2026-03-01', templateId);
  const before = db.getWorkoutFull(workout.id);
  const rowSort = before[0].sort_order;

  // Insert right after the first exercise
  const newWeId = db.addExerciseToWorkout(
    workout.id,
    'Smoke Face Pull',
    3,
    '12',
    rowSort,
    false,
  );
  assert.ok(newWeId, 'should return new workout_exercise id');

  const after = db.getWorkoutFull(workout.id);
  assert.equal(after.length, 3);
  assert.equal(after[0].exercise_name, 'Smoke Row');
  assert.equal(after[1].exercise_name, 'Smoke Face Pull');
  assert.equal(after[2].exercise_name, 'Smoke Pullup');

  // Template must remain unchanged (is_adhoc=1 hides it)
  const templateExercises = db.getDayExercises(templateId);
  assert.equal(templateExercises.length, 2, 'ad-hoc add must not appear in template editor');
});

// --- Exercise swaps --------------------------------------------------------

test('swapWorkoutExercise sets and clears override_exercise_id', () => {
  const { templateId } = buildTemplate('Smoke-Swap', [
    { name: 'Smoke Barbell Curl', targetSets: 3, targetReps: '10' },
  ]);
  const workout = db.initWorkoutFromTemplate('2026-03-08', templateId);
  const full = db.getWorkoutFull(workout.id);
  const weId = full[0].id;

  db.swapWorkoutExercise(weId, 'Smoke Dumbbell Curl');
  const swapped = db.getWorkoutFull(workout.id)[0];
  assert.equal(swapped.override_exercise_name, 'Smoke Dumbbell Curl');

  db.swapWorkoutExercise(weId, null);
  const cleared = db.getWorkoutFull(workout.id)[0];
  assert.equal(cleared.override_exercise_name, null);
});

// --- Trend aggregation -----------------------------------------------------

test('getExerciseTrend produces volume and completion, excluding warmups', () => {
  const { templateId, deIds } = buildTemplate('Smoke-Trend', [
    { name: 'Smoke Warmup Bench', targetSets: 1, targetReps: '10', isWarmup: true },
    { name: 'Smoke Trend Bench', targetSets: 3, targetReps: '8' },
  ]);

  // Session 1
  const w1 = db.initWorkoutFromTemplate('2026-04-01', templateId);
  const s1 = db.getWorkoutFull(w1.id);
  // warmup set — should be ignored by the trend
  db.saveWorkoutExercise(s1[0].id, [
    { weight: 20, reps: 10, target_reps: 10, completed: 1 },
  ]);
  // main sets
  db.saveWorkoutExercise(s1[1].id, [
    { weight: 80, reps: 8, target_reps: 8, completed: 1 },
    { weight: 80, reps: 8, target_reps: 8, completed: 1 },
    { weight: 80, reps: 6, target_reps: 8, completed: 1 },
  ]);

  // Session 2 — one AMRAP set and a missed one
  const w2 = db.initWorkoutFromTemplate('2026-04-04', templateId);
  const s2 = db.getWorkoutFull(w2.id);
  db.saveWorkoutExercise(s2[1].id, [
    { weight: 82.5, reps: 8, target_reps: 8, completed: 1 },
    { weight: 82.5, reps: 8, target_reps: 8, completed: 1 },
    { weight: 82.5, reps: 12, target_reps: 8, completed: 1, is_amrap: 1 },
  ]);

  // Resolve the underlying exercise id for the main lift
  const deRow = db.getDb()
    .prepare('SELECT exercise_id FROM day_exercises WHERE id = ?')
    .get(deIds[1]);
  const trend = db.getExerciseTrend(deRow.exercise_id);

  assert.equal(trend.length, 2, 'one point per session date');
  assert.equal(trend[0].date, '2026-04-01');
  assert.equal(trend[1].date, '2026-04-04');

  // Session 1 volume: 80*8 + 80*8 + 80*6 = 1760
  assert.equal(trend[0].total_volume, 1760);
  // Session 1 completion: (1 + 1 + 6/8) / 3 = 0.9166... -> 92%
  assert.equal(trend[0].completion_pct, 92);

  // Session 2 volume: 82.5*(8+8+12) = 2310
  assert.equal(trend[1].total_volume, 2310);
  // Session 2 completion: (1 + 1 + 1 AMRAP) / 3 = 100%
  assert.equal(trend[1].completion_pct, 100);
});

test('getPerformedExercises excludes warmups and skipped exercises', () => {
  const { templateId, deIds } = buildTemplate('Smoke-Performed', [
    { name: 'Smoke Performed Warmup', targetSets: 1, targetReps: '10', isWarmup: true },
    { name: 'Smoke Performed Main', targetSets: 3, targetReps: '8' },
  ]);

  const w = db.initWorkoutFromTemplate('2026-05-02', templateId);
  const full = db.getWorkoutFull(w.id);

  // Warmup has a completed set — should still be excluded from performed list
  db.saveWorkoutExercise(full[0].id, [
    { weight: 20, reps: 10, target_reps: 10, completed: 1 },
  ]);
  db.saveWorkoutExercise(full[1].id, [
    { weight: 60, reps: 8, target_reps: 8, completed: 1 },
  ]);

  const performed = db.getPerformedExercises();
  const names = performed.map(p => p.name);
  assert.ok(names.includes('Smoke Performed Main'), 'main lift appears');
  assert.ok(!names.includes('Smoke Performed Warmup'), 'warmup must be excluded');
});

// --- Template duplication naming ------------------------------------------

test('duplicateTemplate auto-numbers repeated copies', () => {
  const { templateId } = buildTemplate('DupSeries', [
    { name: 'DupSeries Lift', targetSets: 3, targetReps: '5' },
  ]);

  const first = db.duplicateTemplate(templateId);
  assert.equal(first.name, 'DupSeries Copy');

  const second = db.duplicateTemplate(templateId);
  assert.equal(second.name, 'DupSeries Copy 2');

  // Duplicating one of the copies should strip the suffix, not stack it.
  const third = db.duplicateTemplate(first.id);
  assert.equal(third.name, 'DupSeries Copy 3');
});

test('duplicateTemplate respects explicit unique names', () => {
  const { templateId } = buildTemplate('DupExplicit', [
    { name: 'DupExplicit Lift', targetSets: 1, targetReps: '5' },
  ]);
  const out = db.duplicateTemplate(templateId, 'DupExplicit Alt');
  assert.equal(out.name, 'DupExplicit Alt');
});

// --- Bodyweight helpers ----------------------------------------------------

test('bodyweight helpers insert, upsert, list, and delete', () => {
  // Start from a clean slate so ordering assertions are stable.
  db.getDb().prepare('DELETE FROM body_weights').run();

  db.logBodyWeight('2026-01-10', 80.5);
  db.logBodyWeight('2026-01-12', 80.2);
  db.logBodyWeight('2026-01-15', 79.8);

  let rows = db.getBodyWeights();
  assert.equal(rows.length, 3);
  // Returned DESC by date
  assert.equal(rows[0].date, '2026-01-15');
  assert.equal(rows[2].date, '2026-01-10');

  // Upsert on conflict (same date)
  db.logBodyWeight('2026-01-12', 81.0);
  rows = db.getBodyWeights();
  assert.equal(rows.length, 3, 'upsert must not add a duplicate row');
  const jan12 = rows.find(r => r.date === '2026-01-12');
  assert.equal(jan12.weight_kg, 81.0);

  db.deleteBodyWeight('2026-01-12');
  rows = db.getBodyWeights();
  assert.equal(rows.length, 2);
  assert.ok(!rows.some(r => r.date === '2026-01-12'));
});
