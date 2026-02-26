#!/bin/bash
# Replicate production database to a local database for safe migration testing.
# Usage: ./scripts/replicate-prod-db.sh [local_db_name]
#
# Reads DATABASE_URL from .env.prod to connect to production Neon DB.
# Creates a local database and restores the dump into it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")"

# Add PostgreSQL binaries to PATH
export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"

# Parse prod DATABASE_URL from .env.prod
PROD_DB_URL=$(grep -E '^DATABASE_URL=' "$SERVER_DIR/.env.prod" | head -1 | sed 's/^DATABASE_URL=//')

if [ -z "$PROD_DB_URL" ]; then
  echo "ERROR: DATABASE_URL not found in .env.prod"
  exit 1
fi

# Local DB name
LOCAL_DB="${1:-linkmind_pro_$(date +%Y%m%d)}"
LOCAL_USER="linkmind"
LOCAL_HOST="localhost"
LOCAL_PORT="5432"

DUMP_FILE="/tmp/${LOCAL_DB}.dump"

echo "=== Replicating production DB to local: ${LOCAL_DB} ==="
echo ""

# Step 1: Dump production database
echo "[1/3] Dumping production database..."
pg_dump "$PROD_DB_URL" --format=custom --no-owner --no-privileges -f "$DUMP_FILE"
echo "  Dump saved to: $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"

# Step 2: Create local database
echo "[2/3] Creating local database: ${LOCAL_DB}..."
# Drop if exists (for re-runs)
psql -U "$LOCAL_USER" -h "$LOCAL_HOST" -p "$LOCAL_PORT" -d postgres -c "DROP DATABASE IF EXISTS \"${LOCAL_DB}\";" 2>/dev/null || true
psql -U "$LOCAL_USER" -h "$LOCAL_HOST" -p "$LOCAL_PORT" -d postgres -c "CREATE DATABASE \"${LOCAL_DB}\";"

# Step 3: Restore dump
echo "[3/3] Restoring dump into ${LOCAL_DB}..."
pg_restore --no-owner --no-privileges -U "$LOCAL_USER" -h "$LOCAL_HOST" -p "$LOCAL_PORT" -d "$LOCAL_DB" "$DUMP_FILE" 2>&1 || true
# pg_restore may return non-zero for warnings (e.g., extensions), that's OK

echo ""
echo "=== Done! ==="
echo "Local replica: postgresql://${LOCAL_USER}@${LOCAL_HOST}:${LOCAL_PORT}/${LOCAL_DB}"
echo "Dump file: ${DUMP_FILE}"
echo ""
echo "To test 005 migration against this replica:"
echo "  cd server && DATABASE_URL=postgresql://${LOCAL_USER}@${LOCAL_HOST}:${LOCAL_PORT}/${LOCAL_DB} node dist/cli.js run-sql migrations/005_share_records.sql"
