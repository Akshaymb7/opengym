-- Meals: what was eaten, per profile and per day, kept apart from the training document so food
-- never touches the sync of workouts. Photos are not stored: only what was read from them.

CREATE TABLE meals (
  id      TEXT PRIMARY KEY,
  uid     TEXT NOT NULL,
  day     TEXT NOT NULL,            -- YYYY-MM-DD, the device's own calendar day
  data    TEXT NOT NULL,            -- { id, day, at, slot, items: [{ name, grams, kcal, protein, carbs, fat }], source, note }
  updated INTEGER NOT NULL          -- ms
);
CREATE INDEX meals_uid_day ON meals(uid, day);

-- The daily targets, one row per profile: { kcal, protein }.
CREATE TABLE meal_prefs (
  uid  TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

-- Photos read per profile per UTC day (Workers AI's free allocation resets at 00:00 UTC).
CREATE TABLE ai_usage (
  uid  TEXT NOT NULL,
  day  TEXT NOT NULL,
  n    INTEGER NOT NULL,
  PRIMARY KEY (uid, day)
);
