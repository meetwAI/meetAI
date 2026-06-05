-- Migration: add profile fields to users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS age          INT,
  ADD COLUMN IF NOT EXISTS phone        TEXT,
  ADD COLUMN IF NOT EXISTS location     TEXT;
