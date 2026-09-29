\set ON_ERROR_STOP on
SELECT 1 / (pg_catalog.current_database() = :'expected_database')::integer AS database_target_guard;
REVOKE pkc_mfa_owner FROM pkc_mfa_migrator;
ALTER ROLE pkc_mfa_migrator NOLOGIN;
