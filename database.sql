-- ============================================================
--  AgriCRM  –  Database Setup Script
--  Run this on a fresh PostgreSQL database to create all tables.
--
--  Tables:
--    1. admin                  – shop owner / login account
--    2. customers              – customer records
--    3. customer_transactions  – sales / credit transactions
--    4. payment_logs           – installment / partial payments
--    5. session                – express-session store
-- ============================================================


-- -----------------------------------------------
-- 1. ADMIN  (shop owner / login account)
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS admin (
    admin_id     SERIAL          PRIMARY KEY,
    shop_name    VARCHAR(100)    NOT NULL,
    owner_name   VARCHAR(100)    NOT NULL,
    owner_phone  VARCHAR(15)     NOT NULL,
    shop_address TEXT            NOT NULL,
    pincode      VARCHAR(15),
    tehsil       VARCHAR(100),
    district     VARCHAR(100),
    email        VARCHAR(100)    NOT NULL UNIQUE,
    password     VARCHAR(255)    NOT NULL,
    shop_image   VARCHAR(255),
    slug         VARCHAR(500),
    created_at   TIMESTAMP       DEFAULT CURRENT_TIMESTAMP
);


-- -----------------------------------------------
-- 2. CUSTOMERS
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
    id               SERIAL          PRIMARY KEY,
    name             VARCHAR(100)    NOT NULL,
    mobile_number    VARCHAR(10)     NOT NULL,
    pincode          VARCHAR(6)      NOT NULL,
    village_city     VARCHAR(100)    NOT NULL,
    district         VARCHAR(100)    NOT NULL,
    state            VARCHAR(100)    NOT NULL,
    complete_address TEXT            NOT NULL,
    is_active        BOOLEAN         DEFAULT TRUE,
    created_by       INTEGER         REFERENCES admin (admin_id) ON DELETE SET NULL,
    created_at       TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP       DEFAULT CURRENT_TIMESTAMP
);


-- -----------------------------------------------
-- 3. CUSTOMER TRANSACTIONS
--    paid_amount and remaining_amount are NOT stored;
--    they are computed at query time from payment_logs.
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS customer_transactions (
    id                   SERIAL          PRIMARY KEY,
    customer_id          INTEGER         NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
    transaction_type     VARCHAR(20)     NOT NULL,   -- 'full_payment' | 'credit' | 'installment'
    product_service      VARCHAR(100)    NOT NULL,
    total_amount         NUMERIC         NOT NULL,
    status               VARCHAR(20)     DEFAULT 'active',
    payment_date         DATE            NOT NULL,
    next_payment_date    DATE,
    rating               INTEGER,
    notes                TEXT,
    payment_completed_at TIMESTAMP,
    created_by           INTEGER         REFERENCES admin (admin_id) ON DELETE SET NULL,
    created_at           TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMP       DEFAULT CURRENT_TIMESTAMP
);


-- -----------------------------------------------
-- 4. PAYMENT LOGS  (each installment / partial payment)
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS payment_logs (
    id             SERIAL      PRIMARY KEY,
    transaction_id INTEGER     NOT NULL REFERENCES customer_transactions (id) ON DELETE CASCADE,
    amount         NUMERIC     NOT NULL,
    payment_date   DATE        NOT NULL,
    notes          TEXT,
    rating         INTEGER,
    created_at     TIMESTAMP   DEFAULT NOW()
);


-- -----------------------------------------------
-- 5. SESSION  (connect-pg-simple / express-session)
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS session (
    sid     VARCHAR         NOT NULL PRIMARY KEY,
    sess    JSON            NOT NULL,
    expire  TIMESTAMP(6)    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_expire ON session (expire);
