-- openGym on D1. Accounts are stored as JSON rows (the same records api/server.js keeps in
-- db.json), so the shared modules in ../api (passkeys-store.js, sync-stamps.js) work on them as is.

CREATE TABLE users (
  id      TEXT PRIMARY KEY,
  data    TEXT NOT NULL,            -- { id, name, created, admin?, owner?, sv?, pw?, email?, invitedBy?, disabled? }
  created TEXT NOT NULL
);

CREATE TABLE creds (
  id      TEXT PRIMARY KEY,         -- WebAuthn credential id
  user_id TEXT NOT NULL,
  data    TEXT NOT NULL             -- { id, userId, publicKey, counter, transports, name?, created, lastUsed }
);
CREATE INDEX creds_user ON creds(user_id);

CREATE TABLE invites (
  code    TEXT PRIMARY KEY,
  data    TEXT NOT NULL             -- { code, note, createdBy, created, usedBy?, usedAt? }
);

-- One-shot, short-lived: WebAuthn challenges and phone pairing codes (in memory in api/server.js;
-- Workers have no shared memory, so they live here).
CREATE TABLE challenges (
  cid  TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  exp  INTEGER NOT NULL
);
CREATE TABLE pairings (
  code TEXT PRIMARY KEY,
  uid  TEXT NOT NULL,
  exp  INTEGER NOT NULL
);

-- Wrong-password pauses, per account and per address.
CREATE TABLE throttle (
  key     TEXT PRIMARY KEY,
  fails   INTEGER NOT NULL,
  until   INTEGER NOT NULL,
  updated INTEGER NOT NULL
);

-- The training document of each profile. Split into parts because a D1 row holds at most 2 MB,
-- and kept for the last few revisions, which doubles as a backup history.
CREATE TABLE state_meta (
  uid          TEXT PRIMARY KEY,
  rev          INTEGER NOT NULL,
  wid          TEXT,
  parts        INTEGER NOT NULL,
  bytes        INTEGER NOT NULL,
  updated      INTEGER NOT NULL,     -- ms, the last push
  workouts     INTEGER NOT NULL DEFAULT 0,
  last_workout TEXT
);
CREATE TABLE state_parts (
  uid  TEXT NOT NULL,
  rev  INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- 'doc' (what clients get) | 'notes' (server-only: _unstamped, _prior)
  idx  INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (uid, rev, kind, idx)
);
-- One write per base revision: two devices pushing over the same revision at the same moment
-- collide here, inside the write's own transaction, and the second gets the 409 to merge.
CREATE TABLE state_writes (
  uid      TEXT NOT NULL,
  base_rev INTEGER NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (uid, base_rev)
);
