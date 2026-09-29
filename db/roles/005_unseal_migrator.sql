\set ON_ERROR_STOP on
SELECT 1 / (pg_catalog.current_database() = :'expected_database')::integer AS database_target_guard;
ALTER ROLE pkc_mfa_migrator LOGIN;
GRANT pkc_mfa_owner TO pkc_mfa_migrator WITH SET TRUE, INHERIT FALSE;
