CREATE TEMP TRIGGER fail_format_replace
BEFORE UPDATE ON sessions
BEGIN
  SELECT RAISE(ABORT, 'simulated format replacement failure');
END
