ALTER TABLE log_index ADD COLUMN schema_version INTEGER CHECK (
  schema_version IS NULL OR schema_version > 0
);
ALTER TABLE log_index ADD COLUMN sequence INTEGER CHECK (
  sequence IS NULL OR sequence > 0
);
ALTER TABLE log_index ADD COLUMN checksum TEXT CHECK (
  checksum IS NULL OR length(checksum) = 64
);
ALTER TABLE log_index ADD COLUMN event_type TEXT CHECK (
  event_type IS NULL OR length(trim(event_type)) > 0
);
ALTER TABLE log_index ADD COLUMN log_timestamp TEXT;

CREATE UNIQUE INDEX log_index_file_sequence_idx
  ON log_index(file_path, sequence)
  WHERE sequence IS NOT NULL;

CREATE UNIQUE INDEX log_index_file_offset_idx
  ON log_index(file_path, byte_offset)
  WHERE sequence IS NOT NULL;
