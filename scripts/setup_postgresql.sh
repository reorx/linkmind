#!/bin/bash

# PostgreSQL Setup Script for LinkMind
# This script creates the database and user for LinkMind.
# Assumes PostgreSQL is already installed and running (via Homebrew).
#
# Usage: ./scripts/setup_postgresql.sh

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Database configuration
DB_NAME="linkmind"
DB_USER="linkmind"
DB_PASSWORD="linkmind"
DB_HOST="localhost"
DB_PORT="5432"

print_step() {
    echo -e "\n${BLUE}📍 Step $1: $2${NC}"
    echo "----------------------------------------"
}

echo -e "${BLUE}🚀 Setting up PostgreSQL for LinkMind${NC}"
echo "================================================="

print_step 1 "Checking PostgreSQL"

if ! pg_isready -h "$DB_HOST" -p "$DB_PORT" >/dev/null 2>&1; then
    echo -e "${RED}❌ PostgreSQL is not running${NC}"
    echo "Start it with: brew services start postgresql@14"
    exit 1
fi
echo -e "${GREEN}✅ PostgreSQL is running${NC}"

print_step 2 "Creating database user"

if psql postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
    echo -e "${YELLOW}⚠️  User '$DB_USER' already exists${NC}"
else
    createuser "$DB_USER" || {
        echo -e "${RED}❌ Failed to create user${NC}"
        exit 1
    }
    echo -e "${GREEN}✅ User '$DB_USER' created${NC}"
fi

echo "Setting password for user '$DB_USER'..."
psql postgres -c "ALTER USER $DB_USER WITH PASSWORD '$DB_PASSWORD';" >/dev/null
echo -e "${GREEN}✅ Password set${NC}"

print_step 3 "Creating database"

if psql postgres -lqt | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
    echo -e "${YELLOW}⚠️  Database '$DB_NAME' already exists${NC}"
else
    createdb -O "$DB_USER" "$DB_NAME" || {
        echo -e "${RED}❌ Failed to create database${NC}"
        exit 1
    }
    echo -e "${GREEN}✅ Database '$DB_NAME' created, owned by '$DB_USER'${NC}"
fi

print_step 4 "Creating schema"

PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" <<'SQL'
CREATE TABLE IF NOT EXISTS links (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL,
    og_title TEXT,
    og_description TEXT,
    og_image TEXT,
    og_site_name TEXT,
    og_type TEXT,
    markdown TEXT,
    summary TEXT,
    insight TEXT,
    related_notes JSONB DEFAULT '[]'::jsonb,
    related_links JSONB DEFAULT '[]'::jsonb,
    tags JSONB DEFAULT '[]'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_links_status ON links (status);
CREATE INDEX IF NOT EXISTS idx_links_url ON links (url);
CREATE INDEX IF NOT EXISTS idx_links_created_at ON links (created_at DESC);
SQL

echo -e "${GREEN}✅ Schema created${NC}"

print_step 5 "Testing connection"

if PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT COUNT(*) FROM links;" >/dev/null 2>&1; then
    echo -e "${GREEN}✅ Connection verified${NC}"
else
    echo -e "${RED}❌ Connection test failed${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}🎉 PostgreSQL setup complete!${NC}"
echo ""
echo "Database Configuration:"
echo "======================"
echo "Host:     $DB_HOST"
echo "Port:     $DB_PORT"
echo "Database: $DB_NAME"
echo "User:     $DB_USER"
echo "Password: $DB_PASSWORD"
echo ""
echo "DATABASE_URL=postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"
echo ""
echo "Add this to your .env file, then run the migration script:"
echo "  ./scripts/migrate_from_sqlite.sh"
