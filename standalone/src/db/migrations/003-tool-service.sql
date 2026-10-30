CREATE TABLE message_suppressions (
  companion_id TEXT NOT NULL, message_id TEXT NOT NULL, memory_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>=1), reason TEXT NOT NULL,
  PRIMARY KEY(companion_id,message_id,memory_id),
  FOREIGN KEY(companion_id,message_id) REFERENCES messages(companion_id,id),
  FOREIGN KEY(companion_id,memory_id) REFERENCES memory_records(companion_id,id)
) STRICT;
CREATE TRIGGER live_suppression_immutable BEFORE UPDATE ON message_suppressions
BEGIN SELECT RAISE(ABORT,'message suppression is immutable'); END;
CREATE TABLE interactive_changes (
  companion_id TEXT NOT NULL, credential_id TEXT NOT NULL, tool_name TEXT NOT NULL, request_id TEXT NOT NULL,
  content_object_id TEXT NOT NULL,
  PRIMARY KEY(companion_id,credential_id,tool_name,request_id),
  FOREIGN KEY(companion_id,credential_id,tool_name,request_id) REFERENCES write_requests(companion_id,credential_id,tool_name,request_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(companion_id,content_object_id) REFERENCES content_objects(companion_id,id)
) STRICT;
CREATE TRIGGER interactive_change_immutable BEFORE UPDATE ON interactive_changes
BEGIN SELECT RAISE(ABORT,'interactive changes are immutable'); END;
CREATE TRIGGER interactive_change_delete_guard BEFORE DELETE ON interactive_changes
BEGIN SELECT RAISE(ABORT,'interactive changes are immutable'); END;
CREATE TRIGGER live_suppression_delete_guard BEFORE DELETE ON message_suppressions
BEGIN SELECT RAISE(ABORT,'message suppression is immutable'); END;
