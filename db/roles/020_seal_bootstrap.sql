\set ON_ERROR_STOP on
\if :{?bootstrap_role}
\else
  \echo 'bootstrap_role variable is required'
  \quit 1
\endif
\if :{?expected_database}
\else
  \echo 'expected_database variable is required'
  \quit 1
\endif

SELECT 1 / (pg_catalog.current_database() = :'expected_database')::integer AS database_target_guard;
SELECT 1 / (current_user = :'bootstrap_role')::integer AS bootstrap_session_guard;
SELECT 1 / (:'bootstrap_role' = 'pkc_bootstrap_admin')::integer AS bootstrap_name_guard;
SELECT 1 / ((SELECT count(*) FROM pkc_auth.migration_ledger) = 4)::integer AS migration_ledger_guard;
SELECT 1 / ((SELECT NOT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname='pkc_mfa_migrator'))::integer AS migrator_sealed_guard;
ALTER ROLE pkc_bootstrap_admin NOLOGIN;
