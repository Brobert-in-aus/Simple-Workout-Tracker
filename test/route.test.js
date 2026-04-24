const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-route-'));
process.env.WORKOUT_DB_PATH = path.join(tmpDir, 'route.db');

const db = require('../database');
const { app } = require('../server');

db.getDb();

let server;
let baseUrl;

test.before(async () => {
  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1');
    s.once('listening', () => resolve(s));
    s.once('error', reject);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
  db.closeDb();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

async function request(pathname, options = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body == null ? undefined : JSON.stringify(options.body),
  });
  const contentType = res.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const message = payload && typeof payload === 'object' && payload.error ? payload.error : String(payload);
    throw new Error(`HTTP ${res.status}: ${message}`);
  }
  return payload;
}

function createTemplateWithExercise(templateName, exerciseName, targetSets = 3, targetReps = '8') {
  const templateId = db.createTemplate(templateName);
  const exerciseId = db.getOrCreateExercise(exerciseName);
  const dayExerciseId = db.addDayExercise(
    templateId,
    exerciseId,
    targetSets,
    targetReps,
    0,
    null,
    null,
    false,
    false,
    false,
    false
  );
  return { templateId, exerciseId, dayExerciseId };
}

test('POST /api/workout/:date/begin respects targets_independent previous-data scope', async () => {
  const sharedExercise = 'Route Scoped Press';
  const source = createTemplateWithExercise('Route Source', sharedExercise, 3, '5');
  const independent = createTemplateWithExercise('Route Independent', sharedExercise, 2, '12');
  db.updateDayExercise(independent.dayExerciseId, { targets_independent: 1 });

  const prevWorkout = db.initWorkoutFromTemplate('2026-04-01', source.templateId);
  const prevExercise = db.getWorkoutFull(prevWorkout.id)[0];
  db.saveWorkoutExercise(prevExercise.id, [
    { weight: 100, reps: 5, target_reps: 5, completed: 1 },
    { weight: 100, reps: 5, target_reps: 5, completed: 1 },
    { weight: 100, reps: 5, target_reps: 5, completed: 1 },
  ]);

  const response = await request('/api/workout/2026-04-08/begin', {
    method: 'POST',
    body: { template_id: independent.templateId },
  });

  assert.equal(response.previous, null);
  assert.equal(response.workout.exercises.length, 1);
  assert.equal(response.workout.exercises[0].sets.length, 2);
  assert.equal(response.workout.exercises[0].sets[0].weight, null);
  assert.equal(response.workout.exercises[0].sets[0].reps, 12);
});

test('POST /api/nutrition/logs upserts template meals through the route', async () => {
  const templateId = db.createMealTemplate({
    name: 'Route Lunch',
    calories_kcal: 400,
    protein_g: 35,
  });

  const first = await request('/api/nutrition/logs', {
    method: 'POST',
    body: {
      date: '2026-04-09',
      meal_template_id: templateId,
      meal_name: 'Route Lunch',
      sort_order: 1,
      calories_kcal: 400,
      protein_g: 35,
    },
  });
  const second = await request('/api/nutrition/logs', {
    method: 'POST',
    body: {
      date: '2026-04-09',
      meal_template_id: templateId,
      meal_name: 'Route Lunch Updated',
      sort_order: 2,
      calories_kcal: 525,
      protein_g: 48,
    },
  });

  assert.equal(second.id, first.id);
  const day = await request('/api/nutrition/logs/2026-04-09');
  assert.equal(day.logs.length, 1);
  assert.equal(day.logs[0].meal_name, 'Route Lunch Updated');
  assert.equal(day.logs[0].calories_kcal, 525);
  assert.equal(day.logs[0].protein_g, 48);
});

test('static app shell is served with module entrypoint', async () => {
  const html = await request('/');
  assert.match(html, /<script type="module" src="app\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="style\.css">/);
});
