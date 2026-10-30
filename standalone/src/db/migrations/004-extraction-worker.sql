CREATE TABLE companion_epochs (
  companion_id TEXT PRIMARY KEY REFERENCES companions(id), memory_epoch INTEGER NOT NULL DEFAULT 0 CHECK(memory_epoch>=0)
) STRICT;
INSERT INTO companion_epochs(companion_id) SELECT id FROM companions;
CREATE TRIGGER initial_memory_epoch AFTER INSERT ON companions
BEGIN INSERT INTO companion_epochs(companion_id) VALUES(NEW.id); END;
CREATE TRIGGER inserted_memory_epoch AFTER INSERT ON memory_records
BEGIN UPDATE companion_epochs SET memory_epoch=memory_epoch+1 WHERE companion_id=NEW.companion_id; END;
CREATE TRIGGER revised_memory_epoch AFTER UPDATE ON memory_records
BEGIN UPDATE companion_epochs SET memory_epoch=memory_epoch+1 WHERE companion_id=NEW.companion_id; END;
CREATE TRIGGER validity_memory_epoch AFTER UPDATE ON memory_validity WHEN NEW.status<>OLD.status OR NEW.version<>OLD.version
BEGIN UPDATE companion_epochs SET memory_epoch=memory_epoch+1 WHERE companion_id=NEW.companion_id; END;

CREATE TABLE turn_processing (
  companion_id TEXT NOT NULL, conversation_id TEXT NOT NULL, branch_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  chain_revision INTEGER NOT NULL, job_id TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>=1),
  PRIMARY KEY(companion_id,conversation_id,branch_id,turn_id,chain_revision),
  FOREIGN KEY(companion_id,conversation_id,branch_id,turn_id,chain_revision) REFERENCES turn_receipts(companion_id,conversation_id,branch_id,turn_id,chain_revision),
  FOREIGN KEY(companion_id,job_id) REFERENCES jobs(companion_id,id)
) STRICT;
INSERT INTO turn_processing SELECT companion_id,conversation_id,branch_id,turn_id,chain_revision,job_id,1 FROM turn_receipts;
CREATE TRIGGER processing_identity BEFORE UPDATE ON turn_processing
WHEN NEW.companion_id<>OLD.companion_id OR NEW.conversation_id<>OLD.conversation_id OR NEW.branch_id<>OLD.branch_id
  OR NEW.turn_id<>OLD.turn_id OR NEW.chain_revision<>OLD.chain_revision OR NEW.generation<>OLD.generation+1 OR NEW.job_id=OLD.job_id
BEGIN SELECT RAISE(ABORT,'processing identity is stable and replacements advance generation'); END;
CREATE TRIGGER processing_scope_insert BEFORE INSERT ON turn_processing WHEN NOT EXISTS (
  SELECT 1 FROM jobs j JOIN turns t ON t.id=NEW.turn_id JOIN conversations c ON c.id=t.conversation_id
  WHERE j.id=NEW.job_id AND j.companion_id=NEW.companion_id
    AND json_extract(j.input_json,'$.conversation_id')=c.external_id AND json_extract(j.input_json,'$.branch_id')=NEW.branch_id
    AND json_extract(j.input_json,'$.turn_id')=t.external_id AND json_extract(j.input_json,'$.sequence')=t.sequence
    AND json_extract(j.input_json,'$.chain_revision')=NEW.chain_revision)
BEGIN SELECT RAISE(ABORT,'processing job must refer to its receipt scope'); END;
CREATE TRIGGER processing_scope_update BEFORE UPDATE ON turn_processing WHEN NOT EXISTS (
  SELECT 1 FROM jobs j JOIN turns t ON t.id=NEW.turn_id JOIN conversations c ON c.id=t.conversation_id
  WHERE j.id=NEW.job_id AND j.companion_id=NEW.companion_id
    AND json_extract(j.input_json,'$.conversation_id')=c.external_id AND json_extract(j.input_json,'$.branch_id')=NEW.branch_id
    AND json_extract(j.input_json,'$.turn_id')=t.external_id AND json_extract(j.input_json,'$.sequence')=t.sequence
    AND json_extract(j.input_json,'$.chain_revision')=NEW.chain_revision)
BEGIN SELECT RAISE(ABORT,'processing job must refer to its receipt scope'); END;
CREATE TRIGGER processing_delete_guard BEFORE DELETE ON turn_processing
BEGIN SELECT RAISE(ABORT,'processing history cannot be removed'); END;

CREATE TABLE model_contexts (
  companion_id TEXT NOT NULL, job_id TEXT NOT NULL, lease_generation INTEGER NOT NULL,
  content_object_id TEXT NOT NULL, memory_epoch INTEGER NOT NULL,
  PRIMARY KEY(companion_id,job_id,lease_generation),
  FOREIGN KEY(companion_id,job_id) REFERENCES jobs(companion_id,id),
  FOREIGN KEY(companion_id,content_object_id) REFERENCES content_objects(companion_id,id)
) STRICT;
CREATE TRIGGER model_context_immutable BEFORE UPDATE ON model_contexts BEGIN SELECT RAISE(ABORT,'model context is immutable'); END;
CREATE TRIGGER model_context_delete BEFORE DELETE ON model_contexts BEGIN SELECT RAISE(ABORT,'model context is immutable'); END;
CREATE TABLE model_invocations (
  id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, job_id TEXT NOT NULL, lease_generation INTEGER NOT NULL,
  budget_day TEXT NOT NULL, model TEXT NOT NULL, reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens>0),
  input_bytes INTEGER NOT NULL CHECK(input_bytes>0), status TEXT NOT NULL CHECK(status IN ('reserved','succeeded','failed','interrupted')),
  prompt_tokens INTEGER, completion_tokens INTEGER, error_code TEXT,
  CHECK(prompt_tokens IS NULL OR prompt_tokens>=0), CHECK(completion_tokens IS NULL OR completion_tokens>=0),
  FOREIGN KEY(companion_id,job_id,lease_generation) REFERENCES model_contexts(companion_id,job_id,lease_generation)
) STRICT;
CREATE INDEX invocation_budget ON model_invocations(companion_id,budget_day);
