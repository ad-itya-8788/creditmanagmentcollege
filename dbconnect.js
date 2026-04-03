// Load environment variables from .env file
require('dotenv').config();

const { Pool } = require('pg');

// Create a connection pool using the DATABASE_URL from environment
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Enable SSL only if the URL requires it (e.g., hosted Postgres)
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require')
        ? { rejectUnauthorized: false }
        : false
});

// Log if the database has an unexpected error
pool.on('error', (err) => {
    console.error('Unexpected database error:', err);
});

module.exports = pool;
