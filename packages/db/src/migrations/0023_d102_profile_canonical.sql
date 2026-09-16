ALTER TABLE "profiles"
  ADD COLUMN "avatar_ref" jsonb,
  ADD COLUMN "public_profile" boolean NOT NULL DEFAULT false;

UPDATE "profiles"
SET "avatar_ref" = CASE
  WHEN "avatar_url" ~ '^/setup/images/avatars/avatar-([0-9]{2})\.webp$'
    THEN jsonb_build_object(
      'kind',
      'preset',
      'id',
      substring("avatar_url" FROM '^/setup/images/avatars/(avatar-[0-9]{2})\.webp$')
    )
  WHEN "avatar_url" ~ '^/api/onboarding/images/avatars/avatar-([0-9]{2})\.webp$'
    THEN jsonb_build_object(
      'kind',
      'preset',
      'id',
      substring("avatar_url" FROM '^/api/onboarding/images/avatars/(avatar-[0-9]{2})\.webp$')
    )
  ELSE NULL
END
WHERE "avatar_url" IS NOT NULL;

ALTER TABLE "profiles" DROP COLUMN "avatar_url";
