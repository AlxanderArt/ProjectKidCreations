\set ON_ERROR_STOP on
SELECT 1 / (pg_catalog.current_database() = :'expected_database')::integer AS database_target_guard;

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
END
$roles$;
ALTER ROLE pkc_mfa_owner WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE pkc_mfa_migrator WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE pkc_mfa_runtime WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE pkc_mfa_verifier WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE pkc_mfa_outbox_worker WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
GRANT pkc_mfa_owner TO pkc_mfa_migrator;
ALTER DATABASE :"expected_database" OWNER TO pkc_mfa_owner;
REVOKE ALL ON DATABASE :"expected_database" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"expected_database" TO pkc_mfa_migrator, pkc_mfa_runtime, pkc_mfa_verifier, pkc_mfa_outbox_worker;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM pkc_mfa_runtime, pkc_mfa_verifier, pkc_mfa_outbox_worker;
ALTER ROLE pkc_mfa_runtime SET statement_timeout='5s';
ALTER ROLE pkc_mfa_runtime SET lock_timeout='2s';
ALTER ROLE pkc_mfa_runtime SET idle_in_transaction_session_timeout='10s';
ALTER ROLE pkc_mfa_outbox_worker SET statement_timeout='5s';
ALTER ROLE pkc_mfa_outbox_worker SET lock_timeout='2s';
ALTER ROLE pkc_mfa_outbox_worker SET idle_in_transaction_session_timeout='10s';
