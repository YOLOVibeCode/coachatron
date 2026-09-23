-- M5: session management & self-service.

-- Add manage_token to booking for athlete self-service magic link (screen 11).
alter table booking add column if not exists manage_token text unique;
