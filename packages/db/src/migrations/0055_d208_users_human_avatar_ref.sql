-- 0055_d208_users_human_avatar_ref.sql
-- D208 — separate the human's own avatar from the agent's avatar.
-- Pre-D208, profiles.avatar_ref was a single jsonb column overloaded
-- with two semantics: the user's customization of their agent avatar
-- (Jeannie / Genie), AND nowhere — the human's own avatar had no home.
-- D207's upload UI exposed the conflation by writing into the agent
-- column. This migration adds users.human_avatar_ref so the human face
-- has a proper place; profiles.avatar_ref retains its (correct)
-- agent-customization semantics.

ALTER TABLE users ADD COLUMN human_avatar_ref jsonb;
