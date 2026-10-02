\set ON_ERROR_STOP on
SELECT 1 / (pg_catalog.current_database() = :'expected_database')::integer AS database_target_guard;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pkc_onboarding_runtime') THEN
    CREATE ROLE pkc_onboarding_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pkc_onboarding_email_worker') THEN
    CREATE ROLE pkc_onboarding_email_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pkc_onboarding_email_reconciler') THEN
    CREATE ROLE pkc_onboarding_email_reconciler LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
END
$roles$;

ALTER ROLE pkc_onboarding_runtime WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE pkc_onboarding_email_worker WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE pkc_onboarding_email_reconciler WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;

REVOKE ALL ON DATABASE :"expected_database" FROM pkc_onboarding_runtime, pkc_onboarding_email_worker, pkc_onboarding_email_reconciler;
GRANT CONNECT ON DATABASE :"expected_database" TO pkc_onboarding_runtime, pkc_onboarding_email_worker, pkc_onboarding_email_reconciler;
REVOKE ALL ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO pkc_mfa_migrator, pkc_mfa_verifier;
REVOKE ALL ON SCHEMA public FROM pkc_onboarding_runtime, pkc_onboarding_email_worker, pkc_onboarding_email_reconciler;

ALTER ROLE pkc_onboarding_runtime SET statement_timeout='5s';
ALTER ROLE pkc_onboarding_runtime SET lock_timeout='2s';
ALTER ROLE pkc_onboarding_runtime SET idle_in_transaction_session_timeout='10s';
ALTER ROLE pkc_onboarding_email_worker SET statement_timeout='5s';
ALTER ROLE pkc_onboarding_email_worker SET lock_timeout='2s';
ALTER ROLE pkc_onboarding_email_worker SET idle_in_transaction_session_timeout='10s';
ALTER ROLE pkc_onboarding_email_reconciler SET statement_timeout='5s';
ALTER ROLE pkc_onboarding_email_reconciler SET lock_timeout='2s';
ALTER ROLE pkc_onboarding_email_reconciler SET idle_in_transaction_session_timeout='10s';

ALTER ROLE pkc_onboarding_runtime IN DATABASE :"expected_database" RESET ALL;
ALTER ROLE pkc_onboarding_email_worker IN DATABASE :"expected_database" RESET ALL;
ALTER ROLE pkc_onboarding_email_reconciler IN DATABASE :"expected_database" RESET ALL;
