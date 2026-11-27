-- Save a failed turn's error message alongside its numbers so reload shows why it stopped, not only that it did.
alter table claude_turns add column error text;
