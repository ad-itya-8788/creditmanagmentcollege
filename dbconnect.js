const { Pool } = require('pg');
require('dotenv').config();

// Simple localhost database connection
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432
});

// Handle pool errors
pool.on('error', (err) => {
  console.error('Database error:', err);
});

module.exports = pool;
