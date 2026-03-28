const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  // Optimize for production - reduce idle connections
  max: process.env.NODE_ENV === 'production' ? 10 : 20, // Max connections
  idleTimeoutMillis: process.env.NODE_ENV === 'production' ? 30000 : 300000, // Close idle connections faster in production
  connectionTimeoutMillis: 2000, // Fail fast if can't connect
  allowExitOnIdle: true // Allow pool to close when idle
});

// Handle pool errors
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  pool.end();
  process.exit(0);
});

module.exports = pool;
