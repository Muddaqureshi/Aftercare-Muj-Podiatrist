-- Public access was explicitly approved for fictional records only.
-- Case records, closure dates, reminder settings, and delivery history are preserved.
DROP TABLE sessions;
DROP TABLE login_challenge;
DELETE FROM limits WHERE key LIKE 'password-auth%' OR key LIKE 'send-code%' OR key LIKE 'auth:%';
