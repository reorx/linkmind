#!/bin/bash

# Migrate data from SQLite to PostgreSQL for LinkMind
# Prerequisites: run setup_postgresql.sh first
#
# Usage: ./scripts/migrate_from_sqlite.sh

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SQLITE_DB="data/linkmind.db"
DB_NAME="linkmind"
DB_USER="linkmind"
DB_PASSWORD="linkmind"
DB_HOST="localhost"
DB_PORT="5432"

CONNECTION_STRING="postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"

print_step() {
    echo -e "\n${BLUE}📍 Step $1: $2${NC}"
    echo "----------------------------------------"
}

echo -e "${BLUE}🔄 Migrating LinkMind data from SQLite to PostgreSQL${NC}"
echo "================================================="

print_step 1 "Checking prerequisites"

if [ ! -f "$SQLITE_DB" ]; then
    echo -e "${RED}❌ SQLite database not found: $SQLITE_DB${NC}"
    exit 1
fi
echo -e "${GREEN}✅ SQLite database found${NC}"

if ! PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" >/dev/null 2>&1; then
    echo -e "${RED}❌ Cannot connect to PostgreSQL. Run setup_postgresql.sh first.${NC}"
    exit 1
fi
echo -e "${GREEN}✅ PostgreSQL connection OK${NC}"

print_step 2 "Counting existing data"

sqlite_count=$(sqlite3 "$SQLITE_DB" "SELECT COUNT(*) FROM links;")
pg_count=$(PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM links;")

echo "SQLite records: $sqlite_count"
echo "PostgreSQL records: $pg_count"

if [ "$pg_count" -gt 0 ]; then
    echo -e "${YELLOW}⚠️  PostgreSQL already has data!${NC}"
    read -p "Clear and re-import? (yes/no): " confirm
    if [ "$confirm" != "yes" ]; then
        echo "Aborted."
        exit 0
    fi
    PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "TRUNCATE links RESTART IDENTITY;"
    echo -e "${GREEN}✅ Cleared existing data${NC}"
fi

print_step 3 "Exporting from SQLite"

# Export to CSV with headers (using tab separator to avoid comma issues in content)
sqlite3 -header -separator $'\t' "$SQLITE_DB" \
    "SELECT id, url, og_title, og_description, og_image, og_site_name, og_type, markdown, summary, insight, related_notes, related_links, tags, status, error_message, created_at, updated_at FROM links ORDER BY id;" \
    > /tmp/linkmind_export.tsv

export_count=$(tail -n +2 /tmp/linkmind_export.tsv | wc -l | xargs)
echo -e "${GREEN}✅ Exported $export_count records to TSV${NC}"

print_step 4 "Importing to PostgreSQL"

# Use COPY for fast bulk import (skip header line)
PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" <<SQL
\\COPY links (id, url, og_title, og_description, og_image, og_site_name, og_type, markdown, summary, insight, related_notes, related_links, tags, status, error_message, created_at, updated_at) FROM '/tmp/linkmind_export.tsv' WITH (FORMAT csv, HEADER true, DELIMITER E'\t', NULL '', QUOTE E'\b');
SQL

imported_count=$(PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM links;")
echo -e "${GREEN}✅ Imported $imported_count records${NC}"

print_step 5 "Resetting sequence"

# Set the serial sequence to max(id) + 1
PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c \
    "SELECT setval('links_id_seq', (SELECT COALESCE(MAX(id), 0) FROM links));"

echo -e "${GREEN}✅ Sequence reset${NC}"

print_step 6 "Verifying"

pg_final=$(PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM links;")
echo "SQLite records:     $sqlite_count"
echo "PostgreSQL records: $pg_final"

if [ "$sqlite_count" = "$pg_final" ]; then
    echo -e "${GREEN}🎉 Migration complete! All $pg_final records migrated successfully.${NC}"
else
    echo -e "${YELLOW}⚠️  Record count mismatch. Please verify manually.${NC}"
fi

# Cleanup
rm -f /tmp/linkmind_export.tsv

echo ""
echo "Next: add DATABASE_URL to .env and update the application code."
