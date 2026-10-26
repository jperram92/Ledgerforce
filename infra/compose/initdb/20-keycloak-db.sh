#!/usr/bin/env bash
# Runs once, on first start of an empty data directory (T-0094, RQ-0041). Keycloak gets its own
# database and its own unprivileged role; LedgerForce roles cannot connect to it, and the
# keycloak role cannot connect to the LedgerForce database. Password from a compose file secret.
set -euo pipefail

kc_pw="$(tr -d '\r\n' <"${KEYCLOAK_DB_PASSWORD_FILE:?set KEYCLOAK_DB_PASSWORD_FILE}")"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v kc_pw="$kc_pw" <<'SQL'
CREATE ROLE keycloak LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'kc_pw';
CREATE DATABASE keycloak OWNER keycloak;
REVOKE CONNECT, TEMPORARY ON DATABASE keycloak FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE keycloak TO keycloak;
-- lf_migrator and lf_app hold explicit CONNECT (packages/db/bootstrap/02_database_grants.sql).
SELECT format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SQL
