# Plan: Templates, Schedule & Warmup Tagging

## Summary
Separate "templates" (named workout plans) from "schedule" (which days of the week they're assigned to). A single template can be assigned to multiple days, and multiple templates can be assigned to the same day. Add proper warmup tagging on template exercises.

---

## 1. Schema Changes (database.js)

### New `schedule` table
```sql
CREATE TABLE IF NOT EXISTS schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_index INTEGER NOT NULL,          -- 0=Mon..6=Sun
  template_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0 -- ordering when multiple per day
);
```

### Add `is_warmup` column to `day_exercises`
```sql
ALTER TABLE day_exercises ADD COLUMN is_warmup INTEGER NOT NULL DEFAULT 0;
```

### Relax `workouts` unique index
Currently: `UNIQUE INDEX idx_workouts_date ON workouts(date)` — only 1 workout per date.
Change to: `UNIQUE INDEX idx_workouts_date_template ON workouts(date, day_id)` — 1 workout per date per template.

### Migration logic
1. Create `schedule` table
2. Populate schedule from existing `days`: `INSERT INTO schedule (day_index, template_id) SELECT day_index, id FROM days WHERE name != ''`
3. Add `is_warmup` column to `day_exercises`
4. Set `is_warmup = 1` for Pull-up 1×10 warmup (day_exercises id=19)
5. Drop old unique index, create new one on (date, day_id)

The `days` table continues to serve as the templates table (id, day_index, name). The `day_index` column on `days` is no longer the source of truth — `schedule` is. We keep `day_index` on `days` for backward compat but stop relying on it.

---

## 2. Database Function Changes (database.js)

### New functions
- `getAllTemplates()` — returns all `days` rows (these ARE templates)
- `createTemplate(name)` — inserts into `days` with day_index=-1 (unscheduled)
- `deleteTemplate(id)` — deletes from `days` (cascade deletes day_exercises + schedule)
- `getSchedule()` — returns all schedule entries joined with template name
- `addScheduleEntry(dayIndex, templateId)` — inserts into schedule
- `removeScheduleEntry(id)` — deletes from schedule
- `getScheduleForDate(date)` — returns array of templates for a date's day_index (replaces `getDayForDate`)
- `getWorkoutsForDate(date)` — returns array of workouts for a date (replaces `getWorkoutForDate`)

### Modified functions
- `addDayExercise()` — add `isWarmup` parameter
- `updateDayExercise()` — add `is_warmup` to allowed fields
- `getDayExercises()` — already returns `de.*` so `is_warmup` will be included automatically
- `initWorkoutFromTemplate()` — unchanged (already takes templateId=dayId)
- `getMostRecentWorkoutForDay()` — unchanged (already works per template)
- `getAllWorkoutDates()` — unchanged (joins on days.id which is template)

### Keep but deprecate
- `getDayForDate()` — replaced by `getScheduleForDate()` but kept for compat
- `getWorkoutForDate()` — replaced by `getWorkoutsForDate()`

---

## 3. API Changes (server.js)

### New endpoints
- `GET /api/templates` — all templates
- `POST /api/templates` — create new template `{name}`
- `PUT /api/templates/:id` — rename template `{name}`
- `DELETE /api/templates/:id` — delete template
- `GET /api/schedule` — full weekly schedule
- `POST /api/schedule` — add schedule entry `{day_index, template_id}`
- `DELETE /api/schedule/:id` — remove schedule entry

### Modified endpoints
- `GET /api/workout/:date` — returns `{workouts: [...], previews: [...]}` instead of single workout. Each entry has template info.
- `POST /api/workout/:date/begin` — now requires `{template_id}` in body to specify which template to begin
- `POST /api/days/:id/exercises` — accept optional `is_warmup` field
- Keep existing `/api/days/:id/exercises` endpoints (days.id = template.id)

---

## 4. Frontend Changes (app.js + style.css)

### Template Tab — complete redesign

**Section 1: Weekly Schedule**
- 7 collapsible day rows (Monday–Sunday)
- Each day shows its assigned templates as removable tags/chips
- "Add template" dropdown (lists all available templates + "Rest" implied by empty)
- Click a template chip to remove it from that day

**Section 2: Templates Library**
- "Create Template" button at top — opens inline form for name
- List of all templates as expandable cards
- Each card shows: template name (editable), exercise count, delete button
- Expanded view: exercise list with warmup badges, add exercise form
- Add exercise form: name input (with autocomplete from existing exercises), sets, reps, warmup toggle
- Exercise rows: name, sets×reps, warmup badge, delete button

### Workout Tab — multi-workout support
- `loadWorkout()` updated to handle array of workouts/previews
- Each template shown as a separate section with header
- Each section has its own Begin Workout button / exercise cards
- If only 1 template for the day, layout stays similar to current (just adds template name header)

### Week Strip
- Show comma-separated template names when multiple per day (e.g., "Leg, Rehab")
- Keep truncation with ellipsis for overflow

### Warmup display
- Template tab: exercise rows show "WARMUP" badge next to name
- Workout tab: keep existing warmup badge + note-based detection as fallback, but now also use `is_warmup` flag from template

---

## 5. Files to modify

| File | Changes |
|------|---------|
| `database.js` | Schema migration, new functions, modified functions |
| `server.js` | New API endpoints, modified workout endpoints |
| `public/app.js` | Template tab rewrite, workout tab multi-template, schedule management |
| `public/style.css` | New styles for schedule chips, template library, create form |
| `public/index.html` | No changes needed (DOM generated by JS) |

---

## 6. Implementation order

1. **database.js** — schema migration + all new/modified functions
2. **server.js** — new API endpoints + modify workout endpoints
3. **public/app.js** — Template tab rewrite, then Workout tab update
4. **public/style.css** — new component styles
5. **Verify** — restart server, test all flows
