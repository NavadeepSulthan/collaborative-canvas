-- Snapshot + delta log per room. Rooms are keyed "<tenant>/<room>".
CREATE TABLE IF NOT EXISTS document_snapshots (
  room_key    TEXT PRIMARY KEY,
  state       BYTEA       NOT NULL,
  version     BIGINT      NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_updates (
  seq         BIGSERIAL PRIMARY KEY,
  room_key    TEXT        NOT NULL,
  update      BYTEA       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_updates_room_seq_idx ON document_updates (room_key, seq);
