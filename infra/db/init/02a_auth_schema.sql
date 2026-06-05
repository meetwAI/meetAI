-- =========================
-- AUTH PROVIDERS TABLE
-- =========================

CREATE TABLE IF NOT EXISTS auth_providers (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    password_hash TEXT,
    UNIQUE (user_id, provider)
);

-- =========================
-- GOOGLE CALENDAR ACCOUNTS TABLE
-- =========================

CREATE TABLE IF NOT EXISTS google_calendar_accounts (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    google_sub TEXT,
    email TEXT,
    refresh_token_iv TEXT,
    refresh_token_ciphertext TEXT,
    refresh_token_tag TEXT,
    access_token_expiry TIMESTAMP,
    is_primary BOOLEAN DEFAULT false,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
