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

# Local DB config
# linkmind user doesn't have createdb privilege, use reorx superuser for DDL
LOCAL_DB="${1:-linkmind_pro_$(date +%Y%m%d)}"
LOCAL_USER="linkmind"
LOCAL_ADMIN="reorx"
LOCAL_HOST="localhost"
LOCAL_PORT="5432"

DUMP_FILE="/tmp/${LOCAL_DB}.dump"

echo "=== Replicating production DB to local: ${LOCAL_DB} ==="
echo ""

# Step 1: Dump production database
echo "[1/4] Dumping production database..."
pg_dump "$PROD_DB_URL" --format=custom --no-owner --no-privileges -f "$DUMP_FILE"
echo "  Dump saved to: $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"

# Step 2: Create local database (requires superuser for CREATE DATABASE + extensions)
echo "[2/4] Creating local database: ${LOCAL_DB}..."
psql -U "$LOCAL_ADMIN" -h "$LOCAL_HOST" -p "$LOCAL_PORT" -d postgres -c "DROP DATABASE IF EXISTS \"${LOCAL_DB}\";" 2>/dev/null || true
psql -U "$LOCAL_ADMIN" -h "$LOCAL_HOST" -p "$LOCAL_PORT" -d postgres -c "CREATE DATABASE \"${LOCAL_DB}\" OWNER ${LOCAL_USER};"

# Step 3: Install extensions (pgvector requires superuser)
echo "[3/4] Installing extensions..."
psql -U "$LOCAL_ADMIN" -h "$LOCAL_HOST" -p "$LOCAL_PORT" -d "$LOCAL_DB" -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Step 4: Restore dump
echo "[4/4] Restoring dump into ${LOCAL_DB}..."
pg_restore --no-owner --no-privileges -U "$LOCAL_ADMIN" -h "$LOCAL_HOST" -p "$LOCAL_PORT" -d "$LOCAL_DB" "$DUMP_FILE" 2>&1 || true
# pg_restore may return non-zero for warnings (e.g., pg_search/BM25 not available locally), that's OK

# Grant permissions to linkmind user
psql -U "$LOCAL_ADMIN" -h "$LOCAL_HOST" -p "$LOCAL_PORT" -d "$LOCAL_DB" -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${LOCAL_USER}; GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${LOCAL_USER};"

echo ""
echo "=== Done! ==="
echo "Local replica: postgresql://${LOCAL_USER}@${LOCAL_HOST}:${LOCAL_PORT}/${LOCAL_DB}"
echo "Dump file: ${DUMP_FILE}"
echo ""
echo "To run migration against this replica:"
echo "  cd server && DATABASE_URL=postgresql://${LOCAL_USER}@${LOCAL_HOST}:${LOCAL_PORT}/${LOCAL_DB} node dist/cli.js migrate"
