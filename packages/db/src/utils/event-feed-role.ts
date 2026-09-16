/** Password-free role provisioning for administrator-owned bootstrap/repair.
 * Restricted application migrations only verify the already provisioned role.
 */
export function buildEventFeedReaderRoleSql(): string {
  return `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_feed_reader') THEN
    CREATE ROLE nautilo_feed_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_feed_reader'
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'nautilo_feed_reader must be a restricted non-login role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'nautilo_feed_reader')) THEN
    RAISE EXCEPTION 'nautilo_feed_reader must not inherit other roles';
  END IF;
  IF NOT pg_has_role('nautilo', 'nautilo_feed_reader', 'MEMBER') THEN
    GRANT nautilo_feed_reader TO nautilo WITH INHERIT FALSE;
  END IF;
  IF NOT pg_has_role('nautilo', 'nautilo_feed_reader', 'SET')
    OR pg_has_role('nautilo_agent', 'nautilo_feed_reader', 'SET')
    OR pg_has_role('nautilo_crypto', 'nautilo_feed_reader', 'SET') THEN
    RAISE EXCEPTION 'Only the product role may assume nautilo_feed_reader';
  END IF;
END $$;
`;
}
