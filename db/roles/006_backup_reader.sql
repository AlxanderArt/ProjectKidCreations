\set ON_ERROR_STOP on
SELECT 1 / (pg_catalog.current_database() = :'expected_database')::integer AS database_target_guard;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pkc_backup_reader') THEN
    CREATE ROLE pkc_backup_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
END
$roles$;

ALTER ROLE pkc_backup_reader WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
REVOKE ALL ON DATABASE :"expected_database" FROM pkc_backup_reader;
GRANT CONNECT ON DATABASE :"expected_database" TO pkc_backup_reader;
REVOKE ALL ON SCHEMA public FROM pkc_backup_reader;
ALTER ROLE pkc_backup_reader SET statement_timeout='30min';
ALTER ROLE pkc_backup_reader SET lock_timeout='5s';
ALTER ROLE pkc_backup_reader SET idle_in_transaction_session_timeout='10s';
ALTER ROLE pkc_backup_reader IN DATABASE :"expected_database" RESET ALL;