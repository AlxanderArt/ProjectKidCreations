\set ON_ERROR_STOP on
SELECT 1 / (pg_catalog.current_database() = :'expected_database')::integer AS database_target_guard;
SELECT 1 / (:'expected_empty_cluster' = 'true')::integer AS explicit_empty_cluster_guard;
SELECT 1 / (pg_catalog.to_regnamespace('pkc_auth') IS NULL)::integer AS schema_absence_guard;
SELECT 1 / (pg_catalog.count(*) = 0)::integer AS role_absence_guard
  FROM pg_catalog.pg_roles
  WHERE rolname !~ '^pg_' AND rolname <> SESSION_USER;
SELECT 1 / (pg_catalog.count(*) = 0)::integer AS target_object_absence_guard
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast';

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pkc_mfa_owner') THEN
    CREATE ROLE pkc_mfa_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pkc_mfa_migrator') THEN
    CREATE ROLE pkc_mfa_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pkc_mfa_runtime') THEN
    CREATE ROLE pkc_mfa_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pkc_mfa_verifier') THEN
    CREATE ROLE pkc_mfa_verifier LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pkc_mfa_outbox_worker') THEN
    CREATE ROLE pkc_mfa_outbox_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pkc_onboarding_runtime') THEN
    CREATE ROLE pkc_onboarding_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pkc_onboarding_email_worker') THEN
    CREATE ROLE pkc_onboarding_email_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pkc_onboarding_email_reconciler') THEN
    CREATE ROLE pkc_onboarding_email_reconciler LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pkc_backup_reader') THEN
    CREATE ROLE pkc_backup_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
END
$roles$;
ALTER ROLE pkc_mfa_owner WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE pkc_mfa_migrator WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE pkc_mfa_runtime WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE pkc_mfa_verifier WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE pkc_mfa_outbox_worker WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE pkc_onboarding_runtime WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE pkc_onboarding_email_worker WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE pkc_onboarding_email_reconciler WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE pkc_backup_reader WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
GRANT pkc_mfa_owner TO pkc_mfa_migrator;
ALTER DATABASE :"expected_database" OWNER TO pkc_mfa_owner;
REVOKE ALL ON DATABASE :"expected_database" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"expected_database" TO pkc_mfa_migrator, pkc_mfa_runtime, pkc_mfa_verifier, pkc_mfa_outbox_worker, pkc_onboarding_runtime, pkc_onboarding_email_worker, pkc_onboarding_email_reconciler, pkc_backup_reader;
REVOKE ALL ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO pkc_mfa_migrator, pkc_mfa_verifier;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM pkc_mfa_runtime, pkc_mfa_verifier, pkc_mfa_outbox_worker, pkc_onboarding_runtime, pkc_onboarding_email_worker, pkc_onboarding_email_reconciler, pkc_backup_reader;
ALTER ROLE pkc_mfa_runtime SET statement_timeout='5s';
ALTER ROLE pkc_mfa_runtime SET lock_timeout='2s';
ALTER ROLE pkc_mfa_runtime SET idle_in_transaction_session_timeout='10s';
ALTER ROLE pkc_mfa_outbox_worker SET statement_timeout='5s';
ALTER ROLE pkc_mfa_outbox_worker SET lock_timeout='2s';
ALTER ROLE pkc_mfa_outbox_worker SET idle_in_transaction_session_timeout='10s';
ALTER ROLE pkc_onboarding_runtime SET statement_timeout='5s';
ALTER ROLE pkc_onboarding_runtime SET lock_timeout='2s';
ALTER ROLE pkc_onboarding_runtime SET idle_in_transaction_session_timeout='10s';
ALTER ROLE pkc_onboarding_email_worker SET statement_timeout='5s';
ALTER ROLE pkc_onboarding_email_worker SET lock_timeout='2s';
ALTER ROLE pkc_onboarding_email_worker SET idle_in_transaction_session_timeout='10s';
ALTER ROLE pkc_onboarding_email_reconciler SET statement_timeout='5s';
ALTER ROLE pkc_onboarding_email_reconciler SET lock_timeout='2s';
ALTER ROLE pkc_onboarding_email_reconciler SET idle_in_transaction_session_timeout='10s';
ALTER ROLE pkc_backup_reader SET statement_timeout='30min';
ALTER ROLE pkc_backup_reader SET lock_timeout='5s';
ALTER ROLE pkc_backup_reader SET idle_in_transaction_session_timeout='10s';
ALTER ROLE pkc_onboarding_runtime IN DATABASE :"expected_database" RESET ALL;
ALTER ROLE pkc_onboarding_email_worker IN DATABASE :"expected_database" RESET ALL;
ALTER ROLE pkc_onboarding_email_reconciler IN DATABASE :"expected_database" RESET ALL;
ALTER ROLE pkc_backup_reader IN DATABASE :"expected_database" RESET ALL;
