const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'workouts.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS exercises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_index INTEGER NOT NULL,
      name TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS day_exercises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
      exercise_id INTEGER NOT NULL REFERENCES exercises(id),
      target_sets INTEGER NOT NULL DEFAULT 3,
      target_reps TEXT NOT NULL DEFAULT '10',
      sort_order INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      superset_group INTEGER
    );

    CREATE TABLE IF NOT EXISTS workouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      day_id INTEGER NOT NULL REFERENCES days(id)
    );

    CREATE TABLE IF NOT EXISTS workout_exercises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
      day_exercise_id INTEGER NOT NULL REFERENCES day_exercises(id),
      sort_order INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS workout_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workout_exercise_id INTEGER NOT NULL REFERENCES workout_exercises(id) ON DELETE CASCADE,
      set_number INTEGER NOT NULL,
      weight REAL,
      reps INTEGER,
      target_reps INTEGER,
      duration_seconds INTEGER,
      completed INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_index INTEGER NOT NULL,
      template_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);

  // --- Migrations ---

  // Migration: add completed column to workout_sets if missing
  try {
    db.prepare("SELECT completed FROM workout_sets LIMIT 1").get();
  } catch (e) {
    db.exec("ALTER TABLE workout_sets ADD COLUMN completed INTEGER NOT NULL DEFAULT 0");
  }

  // Migration: add is_warmup column to day_exercises if missing
  try {
    db.prepare("SELECT is_warmup FROM day_exercises LIMIT 1").get();
  } catch (e) {
    db.exec("ALTER TABLE day_exercises ADD COLUMN is_warmup INTEGER NOT NULL DEFAULT 0");
  }

  // Migration: add is_duration column to day_exercises if missing
  try {
    db.prepare("SELECT is_duration FROM day_exercises LIMIT 1").get();
  } catch (e) {
    db.exec("ALTER TABLE day_exercises ADD COLUMN is_duration INTEGER NOT NULL DEFAULT 0");
  }

  // Migration: add is_amrap and amrap_last_only columns to day_exercises
  try {
    db.prepare("SELECT is_amrap FROM day_exercises LIMIT 1").get();
  } catch (e) {
    db.exec("ALTER TABLE day_exercises ADD COLUMN is_amrap INTEGER NOT NULL DEFAULT 0");
  }
  try {
    db.prepare("SELECT amrap_last_only FROM day_exercises LIMIT 1").get();
  } catch (e) {
    db.exec("ALTER TABLE day_exercises ADD COLUMN amrap_last_only INTEGER NOT NULL DEFAULT 0");
  }

  // Migration: add is_amrap column to workout_sets
  try {
    db.prepare("SELECT is_amrap FROM workout_sets LIMIT 1").get();
  } catch (e) {
    db.exec("ALTER TABLE workout_sets ADD COLUMN is_amrap INTEGER NOT NULL DEFAULT 0");
  }

  // Migration: populate schedule table from days if schedule is empty
  const scheduleCount = db.prepare("SELECT COUNT(*) as c FROM schedule").get().c;
  if (scheduleCount === 0) {
    const days = db.prepare("SELECT id, day_index, name FROM days WHERE name != ''").all();
    if (days.length > 0) {
      const insertSchedule = db.prepare("INSERT INTO schedule (day_index, template_id, sort_order) VALUES (?, ?, 0)");
      const txn = db.transaction(() => {
        for (const d of days) {
          insertSchedule.run(d.day_index, d.id);
        }
      });
      txn();
    }
  }

  // Migration: change workouts unique index from (date) to (date, day_id)
  // Check if old unique index exists by trying to see if there's a unique constraint on date alone
  try {
    db.exec("DROP INDEX IF EXISTS idx_workouts_date");
  } catch (e) { /* ignore */ }
  // Create new composite unique index (safe if already exists)
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_workouts_date_template ON workouts(date, day_id)");

  // Migration: sync linked exercises (same exercise_id across templates)
  // Pick the highest-id day_exercise as canonical and sync settings to all others
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)");
  const migrated = db.prepare("SELECT 1 FROM _migrations WHERE name = 'sync_linked_exercises'").get();
  if (!migrated) {
    const groups = db.prepare(`
      SELECT exercise_id FROM day_exercises GROUP BY exercise_id HAVING COUNT(*) > 1
    `).all();
    const syncFields = ['target_sets', 'target_reps', 'is_warmup', 'is_duration', 'is_amrap', 'amrap_last_only', 'notes'];
    const txn = db.transaction(() => {
      for (const { exercise_id } of groups) {
        const all = db.prepare('SELECT * FROM day_exercises WHERE exercise_id = ? ORDER BY id DESC').all(exercise_id);
        const canonical = all[0];
        for (let i = 1; i < all.length; i++) {
          const sets = [];
          const vals = [];
          for (const f of syncFields) {
            sets.push(`${f} = ?`);
            vals.push(canonical[f]);
          }
          vals.push(all[i].id);
          db.prepare(`UPDATE day_exercises SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        }
      }
      db.prepare("INSERT INTO _migrations (name) VALUES ('sync_linked_exercises')").run();
    });
    txn();
  }
}

// --- Exercise helpers ---

function getOrCreateExercise(name) {
  const trimmed = name.trim();
  let row = db.prepare('SELECT id FROM exercises WHERE name = ?').get(trimmed);
  if (!row) {
    const info = db.prepare('INSERT INTO exercises (name) VALUES (?)').run(trimmed);
    return info.lastInsertRowid;
  }
  return row.id;
}

function getAllExercises() {
  return db.prepare('SELECT * FROM exercises ORDER BY name').all();
}

// --- Template helpers (templates = days table) ---

function getAllTemplates() {
  return db.prepare('SELECT * FROM days ORDER BY name').all();
}

function createTemplate(name) {
  const info = db.prepare('INSERT INTO days (day_index, name) VALUES (-1, ?)').run(name);
  return info.lastInsertRowid;
}

function updateTemplate(id, name) {
  db.prepare('UPDATE days SET name = ? WHERE id = ?').run(name, id);
}

function deleteTemplate(id) {
  // Remove workout history that references this template's exercises
  db.prepare(`
    DELETE FROM workout_sets WHERE workout_exercise_id IN (
      SELECT we.id FROM workout_exercises we
      JOIN day_exercises de ON de.id = we.day_exercise_id
      WHERE de.day_id = ?
    )
  `).run(id);
  db.prepare(`
    DELETE FROM workout_exercises WHERE day_exercise_id IN (
      SELECT id FROM day_exercises WHERE day_id = ?
    )
  `).run(id);
  db.prepare('DELETE FROM workouts WHERE day_id = ?').run(id);
  // Remove from schedule
  db.prepare('DELETE FROM schedule WHERE template_id = ?').run(id);
  // day_exercises will cascade delete due to FK
  db.prepare('DELETE FROM days WHERE id = ?').run(id);
}

// --- Schedule helpers ---

function getSchedule() {
  return db.prepare(`
    SELECT s.*, d.name as template_name
    FROM schedule s
    JOIN days d ON d.id = s.template_id
    ORDER BY s.day_index, s.sort_order
  `).all();
}

function addScheduleEntry(dayIndex, templateId) {
  const existing = db.prepare(
    'SELECT MAX(sort_order) as mx FROM schedule WHERE day_index = ?'
  ).get(dayIndex);
  const sortOrder = existing && existing.mx != null ? existing.mx + 1 : 0;
  const info = db.prepare(
    'INSERT INTO schedule (day_index, template_id, sort_order) VALUES (?, ?, ?)'
  ).run(dayIndex, templateId, sortOrder);
  return info.lastInsertRowid;
}

function removeScheduleEntry(id) {
  db.prepare('DELETE FROM schedule WHERE id = ?').run(id);
}

function getScheduleForDate(date) {
  const d = new Date(date + 'T00:00:00');
  const jsDay = d.getDay(); // 0=Sun
  const dayIndex = jsDay === 0 ? 6 : jsDay - 1; // convert to 0=Mon
  return db.prepare(`
    SELECT s.id as schedule_id, s.sort_order, d.id as template_id, d.name as template_name
    FROM schedule s
    JOIN days d ON d.id = s.template_id
    WHERE s.day_index = ?
    ORDER BY s.sort_order
  `).all(dayIndex);
}

// --- Day/Template helpers (kept for backward compat) ---

function getOrCreateDay(dayIndex, name) {
  let row = db.prepare('SELECT id FROM days WHERE day_index = ?').get(dayIndex);
  if (!row) {
    const info = db.prepare('INSERT INTO days (day_index, name) VALUES (?, ?)').run(dayIndex, name || '');
    return info.lastInsertRowid;
  }
  if (name && name !== row.name) {
    db.prepare('UPDATE days SET name = ? WHERE id = ?').run(name, row.id);
  }
  return row.id;
}

function getAllDays() {
  return db.prepare('SELECT * FROM days ORDER BY day_index').all();
}

function updateDay(id, name) {
  db.prepare('UPDATE days SET name = ? WHERE id = ?').run(name, id);
}

// --- Template exercise helpers ---

function addDayExercise(dayId, exerciseId, targetSets, targetReps, sortOrder, notes, supersetGroup, isWarmup, isDuration, isAmrap, amrapLastOnly) {
  const info = db.prepare(`
    INSERT INTO day_exercises (day_id, exercise_id, target_sets, target_reps, sort_order, notes, superset_group, is_warmup, is_duration, is_amrap, amrap_last_only)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(dayId, exerciseId, targetSets, targetReps, sortOrder, notes || null, supersetGroup || null, isWarmup ? 1 : 0, isDuration ? 1 : 0, isAmrap ? 1 : 0, amrapLastOnly ? 1 : 0);
  return info.lastInsertRowid;
}

function getDayExercises(dayId) {
  return db.prepare(`
    SELECT de.*, e.name as exercise_name
    FROM day_exercises de
    JOIN exercises e ON e.id = de.exercise_id
    WHERE de.day_id = ?
    ORDER BY de.sort_order
  `).all(dayId);
}

function updateDayExercise(id, fields) {
  const allowed = ['target_sets', 'target_reps', 'sort_order', 'notes', 'superset_group', 'exercise_id', 'is_warmup', 'is_duration', 'is_amrap', 'amrap_last_only'];
  const updates = [];
  const values = [];
  for (const [key, val] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (updates.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE day_exercises SET ${updates.join(', ')} WHERE id = ?`).run(...values);
}

function deleteDayExercise(id) {
  const txn = db.transaction(() => {
    // Delete related workout_exercises first (workout_sets cascade from there)
    db.prepare('DELETE FROM workout_exercises WHERE day_exercise_id = ?').run(id);
    db.prepare('DELETE FROM day_exercises WHERE id = ?').run(id);
  });
  txn();
}

function reorderDayExercises(dayId, orderedIds) {
  const stmt = db.prepare('UPDATE day_exercises SET sort_order = ? WHERE id = ? AND day_id = ?');
  const txn = db.transaction(() => {
    orderedIds.forEach((id, idx) => stmt.run(idx, id, dayId));
  });
  txn();
}

// --- Workout helpers ---

function getOrCreateWorkout(date, dayId) {
  let row = db.prepare('SELECT * FROM workouts WHERE date = ? AND day_id = ?').get(date, dayId);
  if (!row) {
    const info = db.prepare('INSERT INTO workouts (date, day_id) VALUES (?, ?)').run(date, dayId);
    row = { id: info.lastInsertRowid, date, day_id: dayId };
  }
  return row;
}

function getWorkoutByDate(date) {
  return db.prepare('SELECT * FROM workouts WHERE date = ?').get(date);
}

function getWorkoutsForDate(date) {
  return db.prepare('SELECT * FROM workouts WHERE date = ?').all(date);
}

function getWorkoutFull(workoutId) {
  const exercises = db.prepare(`
    SELECT we.*, de.exercise_id, de.target_sets, de.target_reps, de.superset_group, de.notes as default_note, de.is_warmup, de.is_duration, de.is_amrap, de.amrap_last_only, e.name as exercise_name
    FROM workout_exercises we
    JOIN day_exercises de ON de.id = we.day_exercise_id
    JOIN exercises e ON e.id = de.exercise_id
    WHERE we.workout_id = ?
    ORDER BY we.sort_order
  `).all(workoutId);

  for (const ex of exercises) {
    ex.sets = db.prepare(`
      SELECT * FROM workout_sets WHERE workout_exercise_id = ? ORDER BY set_number
    `).all(ex.id);
  }
  return exercises;
}

function getWorkoutForDate(date) {
  const workout = getWorkoutByDate(date);
  if (!workout) return null;
  const day = db.prepare('SELECT * FROM days WHERE id = ?').get(workout.day_id);
  return {
    ...workout,
    day_name: day ? day.name : '',
    day_index: day ? day.day_index : 0,
    exercises: getWorkoutFull(workout.id)
  };
}

function getFullWorkoutsForDate(date) {
  const workouts = getWorkoutsForDate(date);
  return workouts.map(w => {
    const day = db.prepare('SELECT * FROM days WHERE id = ?').get(w.day_id);
    return {
      ...w,
      template_id: w.day_id,
      template_name: day ? day.name : '',
      exercises: getWorkoutFull(w.id)
    };
  });
}

function getDayForDate(date) {
  const d = new Date(date + 'T00:00:00');
  const jsDay = d.getDay(); // 0=Sun
  const dayIndex = jsDay === 0 ? 6 : jsDay - 1; // convert to 0=Mon
  return db.prepare('SELECT * FROM days WHERE day_index = ?').get(dayIndex);
}

function initWorkoutFromTemplate(date, templateId) {
  const workout = getOrCreateWorkout(date, templateId);
  const existing = db.prepare('SELECT id FROM workout_exercises WHERE workout_id = ?').all(workout.id);
  if (existing.length > 0) return workout;

  const templateExercises = getDayExercises(templateId);

  // Get previous session's data for pre-fill (cross-template: use most recent for each exercise)
  let prevDataMap = {};
  for (const te of templateExercises) {
    const recent = getMostRecentExerciseData(te.exercise_id, date);
    if (recent && recent.sets && recent.sets.length > 0) {
      prevDataMap[te.id] = recent.sets;
    }
  }

  const insertWe = db.prepare(`
    INSERT INTO workout_exercises (workout_id, day_exercise_id, sort_order, skipped, note)
    VALUES (?, ?, ?, 0, NULL)
  `);
  const insertWs = db.prepare(`
    INSERT INTO workout_sets (workout_exercise_id, set_number, weight, reps, target_reps, duration_seconds, is_amrap)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const txn = db.transaction(() => {
    for (const te of templateExercises) {
      const weInfo = insertWe.run(workout.id, te.id, te.sort_order);
      const targetRepsNum = parseInt(te.target_reps);
      const numSets = te.target_sets || 3;
      const prevSets = prevDataMap[te.id] || [];

      for (let s = 1; s <= numSets; s++) {
        const prev = prevSets[s - 1];
        const isDuration = te.is_duration;
        const weight = isDuration ? null : (prev ? prev.weight : null);
        const reps = isDuration ? null : (prev && prev.reps != null ? prev.reps : (isNaN(targetRepsNum) ? null : targetRepsNum));
        const tReps = isDuration ? null : (isNaN(targetRepsNum) ? null : targetRepsNum);
        const duration = prev ? prev.duration_seconds : null;
        const setIsAmrap = te.is_amrap ? (te.amrap_last_only ? (s === numSets ? 1 : 0) : 1) : 0;
        insertWs.run(weInfo.lastInsertRowid, s, weight, reps, tReps, duration, setIsAmrap);
      }
    }
  });
  txn();
  return workout;
}

function getMostRecentWorkoutForDay(dayId, beforeDate) {
  return db.prepare(`
    SELECT * FROM workouts WHERE day_id = ? AND date < ? ORDER BY date DESC LIMIT 1
  `).get(dayId, beforeDate);
}

// --- Workout exercise helpers ---

function saveWorkoutExercise(workoutExerciseId, sets, note, skipped) {
  if (note !== undefined) {
    db.prepare('UPDATE workout_exercises SET note = ? WHERE id = ?').run(note, workoutExerciseId);
  }
  if (skipped !== undefined) {
    db.prepare('UPDATE workout_exercises SET skipped = ? WHERE id = ?').run(skipped ? 1 : 0, workoutExerciseId);
  }

  if (sets && sets.length > 0) {
    db.prepare('DELETE FROM workout_sets WHERE workout_exercise_id = ?').run(workoutExerciseId);
    const stmt = db.prepare(`
      INSERT INTO workout_sets (workout_exercise_id, set_number, weight, reps, target_reps, duration_seconds, completed, is_amrap)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const txn = db.transaction(() => {
      sets.forEach((s, i) => {
        stmt.run(
          workoutExerciseId,
          i + 1,
          s.weight != null ? s.weight : null,
          s.reps != null ? s.reps : null,
          s.target_reps != null ? s.target_reps : null,
          s.duration_seconds != null ? s.duration_seconds : null,
          s.completed ? 1 : 0,
          s.is_amrap ? 1 : 0
        );
      });
    });
    txn();
  }
}

function deleteWorkout(id) {
  db.prepare('DELETE FROM workouts WHERE id = ?').run(id);
}

function reorderWorkoutExercises(workoutId, orderedIds) {
  const stmt = db.prepare('UPDATE workout_exercises SET sort_order = ? WHERE id = ? AND workout_id = ?');
  const txn = db.transaction(() => {
    orderedIds.forEach((id, idx) => stmt.run(idx, id, workoutId));
  });
  txn();
}

// --- Exercise linking helpers ---

function syncLinkedExercises(dayExerciseId, fields) {
  const de = db.prepare('SELECT exercise_id FROM day_exercises WHERE id = ?').get(dayExerciseId);
  if (!de) return;
  const syncable = ['target_sets', 'target_reps', 'is_warmup', 'is_duration', 'is_amrap', 'amrap_last_only', 'notes'];
  const updates = [];
  const values = [];
  for (const [key, val] of Object.entries(fields)) {
    if (syncable.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (updates.length === 0) return;
  values.push(de.exercise_id, dayExerciseId);
  db.prepare(`UPDATE day_exercises SET ${updates.join(', ')} WHERE exercise_id = ? AND id != ?`).run(...values);
}

function getTemplatesForExercise(exerciseId) {
  return db.prepare(`
    SELECT DISTINCT d.id, d.name
    FROM day_exercises de
    JOIN days d ON d.id = de.day_id
    WHERE de.exercise_id = ?
    ORDER BY d.name
  `).all(exerciseId);
}

function getLinkedInfoForTemplate(templateId) {
  // Returns exercise_id -> list of other template names for all exercises in this template
  const exercises = db.prepare('SELECT id, exercise_id FROM day_exercises WHERE day_id = ?').all(templateId);
  const result = {};
  for (const ex of exercises) {
    const others = db.prepare(`
      SELECT DISTINCT d.name
      FROM day_exercises de
      JOIN days d ON d.id = de.day_id
      WHERE de.exercise_id = ? AND de.day_id != ?
      ORDER BY d.name
    `).all(ex.exercise_id, templateId);
    if (others.length > 0) {
      result[ex.id] = others.map(o => o.name);
    }
  }
  return result;
}

function getMostRecentExerciseData(exerciseId, beforeDate) {
  const row = db.prepare(`
    SELECT we.id as we_id, w.date, w.day_id, d.name as template_name,
           we.day_exercise_id, we.skipped, we.note, de.exercise_id
    FROM workout_exercises we
    JOIN day_exercises de ON de.id = we.day_exercise_id
    JOIN workouts w ON w.id = we.workout_id
    JOIN days d ON d.id = w.day_id
    WHERE de.exercise_id = ? AND w.date < ? AND we.skipped = 0
    ORDER BY w.date DESC
    LIMIT 1
  `).get(exerciseId, beforeDate);
  if (!row) return null;
  row.sets = db.prepare('SELECT * FROM workout_sets WHERE workout_exercise_id = ? ORDER BY set_number').all(row.we_id);
  return row;
}

// --- History helpers ---

function getExerciseHistory(exerciseId, limit = 8) {
  return db.prepare(`
    SELECT w.date, we.skipped, we.note, de.target_sets, de.target_reps
    FROM workout_exercises we
    JOIN workouts w ON w.id = we.workout_id
    JOIN day_exercises de ON de.id = we.day_exercise_id
    WHERE de.exercise_id = ?
    ORDER BY w.date DESC
    LIMIT ?
  `).all(exerciseId, limit);
}

function getExerciseHistoryWithSets(exerciseId, limit = 8) {
  const sessions = db.prepare(`
    SELECT we.id as we_id, w.date, we.skipped, we.note, de.target_sets, de.target_reps
    FROM workout_exercises we
    JOIN workouts w ON w.id = we.workout_id
    JOIN day_exercises de ON de.id = we.day_exercise_id
    WHERE de.exercise_id = ?
    ORDER BY w.date DESC
    LIMIT ?
  `).all(exerciseId, limit);

  for (const s of sessions) {
    s.sets = db.prepare('SELECT * FROM workout_sets WHERE workout_exercise_id = ? ORDER BY set_number').all(s.we_id);
  }
  return sessions;
}

function getAllWorkoutDates() {
  return db.prepare(`
    SELECT w.date, w.id, d.name as day_name, d.day_index
    FROM workouts w
    JOIN days d ON d.id = w.day_id
    ORDER BY w.date DESC
  `).all();
}

function getWorkoutDatesInRange(fromDate, toDate) {
  return db.prepare(`
    SELECT DISTINCT date FROM workouts WHERE date >= ? AND date <= ?
  `).all(fromDate, toDate).map(r => r.date);
}

function getWorkoutsInRange(fromDate, toDate) {
  return db.prepare(`
    SELECT w.date, d.name as template_name
    FROM workouts w
    JOIN days d ON d.id = w.day_id
    WHERE w.date >= ? AND w.date <= ?
    ORDER BY w.date
  `).all(fromDate, toDate);
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  getDb,
  closeDb,
  getOrCreateExercise,
  getAllExercises,
  // Template management
  getAllTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  // Schedule management
  getSchedule,
  addScheduleEntry,
  removeScheduleEntry,
  getScheduleForDate,
  // Legacy day helpers
  getOrCreateDay,
  getAllDays,
  updateDay,
  // Template exercise helpers
  addDayExercise,
  getDayExercises,
  updateDayExercise,
  deleteDayExercise,
  reorderDayExercises,
  // Workout helpers
  getOrCreateWorkout,
  getWorkoutByDate,
  getWorkoutsForDate,
  getWorkoutFull,
  getWorkoutForDate,
  getFullWorkoutsForDate,
  getDayForDate,
  initWorkoutFromTemplate,
  getMostRecentWorkoutForDay,
  saveWorkoutExercise,
  deleteWorkout,
  reorderWorkoutExercises,
  // Exercise linking helpers
  syncLinkedExercises,
  getTemplatesForExercise,
  getLinkedInfoForTemplate,
  getMostRecentExerciseData,
  // History helpers
  getExerciseHistory,
  getExerciseHistoryWithSets,
  getAllWorkoutDates,
  getWorkoutDatesInRange,
  getWorkoutsInRange,
};
