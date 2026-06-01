const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/suggesttrade.db');

// Ensure data directory exists
const fs = require('fs');
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    plan TEXT DEFAULT 'free',
    credits INTEGER DEFAULT 3,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    paypal_subscription_id TEXT,
    subscription_status TEXT DEFAULT 'inactive',
    subscription_end DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    asset TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    direction TEXT,
    entry TEXT,
    stop_loss TEXT,
    tp1 TEXT,
    tp2 TEXT,
    lot_suggestion TEXT,
    risk_reward TEXT,
    confidence TEXT,
    rationale_en TEXT,
    rationale_es TEXT,
    images_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    provider_payment_id TEXT,
    amount_usd REAL,
    plan TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Plan definitions
const PLANS = {
  starter: { credits: 30,  price_usd: 9  },
  pro:     { credits: 150, price_usd: 29 },
  elite:   { credits: 600, price_usd: 79 },
};

module.exports = { db, PLANS };
