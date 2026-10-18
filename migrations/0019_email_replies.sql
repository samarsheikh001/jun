-- C-02 / W-08: two-way email. Each conversation gets its own reply address (c-<token>@<reply domain>)
-- the first time the desk emails the customer; their reply to it finds the chat by this token.

ALTER TABLE conversations ADD COLUMN email_token TEXT;
CREATE UNIQUE INDEX conversations_email_token ON conversations (email_token);
