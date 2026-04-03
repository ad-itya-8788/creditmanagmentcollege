// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const path    = require('path');
const db      = require('./dbconnect');

// Import route handlers
const { router: authRouter, sessionMiddleware, requireAuth } = require('./routes/auth');
const customerRouter = require('./routes/customer');
const usersRouter    = require('./routes/users');

const app  = express();
const PORT = process.env.PORT || 3000;

// -------------------------------------------------------------------
// Template engine setup (EJS)
// -------------------------------------------------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// -------------------------------------------------------------------
// Basic middleware
// -------------------------------------------------------------------
app.use(express.json());                                   // Parse JSON bodies
app.use(express.urlencoded({ extended: true }));           // Parse form data
app.use(express.static(path.join(__dirname, 'public')));   // Serve static files
app.use(sessionMiddleware);                                // Session handling

// -------------------------------------------------------------------
// SQL helper: sums total payments per transaction
// Used in dashboard and report queries to compute paid/remaining
// -------------------------------------------------------------------
const PAID_PER_TRANSACTION = `(
    SELECT transaction_id, SUM(amount) AS paid
    FROM payment_logs
    GROUP BY transaction_id
) ps`;

// ===================================================================
// PUBLIC ROUTES — No login required
// ===================================================================

// Home page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Login page
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Signup page
app.get('/signup', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

// ===================================================================
// PROTECTED ROUTES — Login required (requireAuth middleware)
// ===================================================================

// -------------------------------------------------------------------
// Dashboard page
// Shows summary stats: customers, transactions, credit given, pending
// -------------------------------------------------------------------
app.get('/dashboard', requireAuth, async (req, res) => {
    // Default stats used when the DB query fails
    const emptyStats = {
        totalCustomers: 0, newCustomersToday: 0,
        totalTransactions: 0, activeTransactions: 0,
        completedTransactions: 0, pendingTransactions: 0,
        totalCreditGiven: 0, totalPaidAmount: 0,
        totalPendingAmount: 0, overdueTransactions: 0
    };

    try {
        const result = await db.query(`
            SELECT
                COUNT(DISTINCT c.id) AS total_customers,
                COUNT(DISTINCT CASE WHEN c.created_at >= CURRENT_DATE THEN c.id END) AS new_customers_today,
                COUNT(DISTINCT t.id)                               AS total_transactions,
                COUNT(DISTINCT CASE WHEN t.status = 'active'    THEN t.id END) AS active_transactions,
                COUNT(DISTINCT CASE WHEN t.status = 'completed' THEN t.id END) AS completed_transactions,
                COUNT(DISTINCT CASE WHEN t.status = 'pending'   THEN t.id END) AS pending_transactions,
                COALESCE(SUM(t.total_amount), 0)                               AS total_credit_given,
                COALESCE(SUM(COALESCE(ps.paid, 0)), 0)                         AS total_paid_amount,
                -- Only count pending amount for active transactions
                COALESCE(SUM(
                    CASE WHEN t.status = 'active'
                    THEN t.total_amount - COALESCE(ps.paid, 0)
                    ELSE 0 END
                ), 0) AS total_pending_amount,
                -- Overdue: active, past due date, still has balance
                COUNT(DISTINCT CASE
                    WHEN t.next_payment_date < CURRENT_DATE
                    AND (t.total_amount - COALESCE(ps.paid, 0)) > 0
                    AND t.status = 'active'
                    THEN t.id
                END) AS overdue_transactions
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
            LEFT JOIN ${PAID_PER_TRANSACTION} ON ps.transaction_id = t.id
        `);

        const row = result.rows[0] || {};

        res.render('dashboard', {
            user: req.user,
            stats: {
                totalCustomers:       parseInt(row.total_customers)        || 0,
                newCustomersToday:    parseInt(row.new_customers_today)    || 0,
                totalTransactions:    parseInt(row.total_transactions)     || 0,
                activeTransactions:   parseInt(row.active_transactions)    || 0,
                completedTransactions:parseInt(row.completed_transactions) || 0,
                pendingTransactions:  parseInt(row.pending_transactions)   || 0,
                totalCreditGiven:     parseFloat(row.total_credit_given)   || 0,
                totalPaidAmount:      parseFloat(row.total_paid_amount)    || 0,
                totalPendingAmount:   parseFloat(row.total_pending_amount) || 0,
                overdueTransactions:  parseInt(row.overdue_transactions)   || 0
            }
        });

    } catch (err) {
        console.error('Dashboard error:', err);
        res.render('dashboard', { user: req.user, stats: emptyStats });
    }
});

// -------------------------------------------------------------------
// Customers list page
// Shows all customers with their total credit and pending amounts
// -------------------------------------------------------------------
app.get('/customers', requireAuth, async (req, res) => {
    try {
        const result = await db.query(`
            WITH tx_payments AS (
                SELECT
                    t.customer_id,
                    COUNT(t.id)                                        AS transaction_count,
                    COALESCE(SUM(t.total_amount), 0)                   AS total_amount,
                    -- Only count pending from active transactions
                    COALESCE(SUM(
                        CASE WHEN t.status = 'active'
                        THEN t.total_amount - COALESCE(ps.paid, 0)
                        ELSE 0 END
                    ), 0) AS total_pending_amount
                FROM customer_transactions t
                LEFT JOIN ${PAID_PER_TRANSACTION} ON ps.transaction_id = t.id
                GROUP BY t.customer_id
            )
            SELECT
                c.id, c.name, c.mobile_number, c.village_city,
                c.district, c.state, c.created_at,
                COALESCE(tp.transaction_count, 0)    AS transaction_count,
                COALESCE(tp.total_amount, 0)         AS total_amount,
                COALESCE(tp.total_pending_amount, 0) AS total_pending_amount
            FROM customers c
            LEFT JOIN tx_payments tp ON tp.customer_id = c.id
            ORDER BY c.created_at DESC
        `);

        res.render('customers', { user: req.user, customers: result.rows });

    } catch (err) {
        console.error('Customers page error:', err);
        res.render('customers', { user: req.user, customers: [] });
    }
});

// -------------------------------------------------------------------
// Settings page
// Shows the admin's account info and basic usage statistics
// -------------------------------------------------------------------
app.get('/settings', requireAuth, async (req, res) => {
    try {
        // Get total customers and transactions
        const statsResult = await db.query(`
            SELECT
                COUNT(DISTINCT c.id) AS total_customers,
                COUNT(t.id)          AS total_transactions
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
        `);

        // Count active login sessions
        const sessionsResult = await db.query(`
            SELECT COUNT(*) AS session_count
            FROM session
            WHERE sess::text LIKE '%admin_id%'
            AND expire > NOW()
        `);

        const stats    = statsResult.rows[0]    || {};
        const sessions = sessionsResult.rows[0] || {};

        res.render('settings', {
            user:                    req.user,
            customersCreatedByUser:  parseInt(stats.total_customers)    || 0,
            totalTransactions:       parseInt(stats.total_transactions)  || 0,
            activeSessions:          parseInt(sessions.session_count)   || 1
        });

    } catch (err) {
        console.error('Settings page error:', err);
        res.render('settings', {
            user: req.user,
            customersCreatedByUser: 0,
            totalTransactions: 0,
            activeSessions: 1
        });
    }
});

// -------------------------------------------------------------------
// Report page
// Shows full credit report: totals, clear customers, and pending ones
// -------------------------------------------------------------------
app.get('/report', requireAuth, async (req, res) => {
    // Default empty data if DB fails
    const emptyReport = {
        user: req.user, title: 'Report - AgriCrm',
        totalCustomers: 0, totalTransactions: 0,
        totalPending: 0, totalClear: 0,
        clearCustomers: [], pendingCustomers: [], allCustomers: []
    };

    try {
        // --- Overall summary numbers ---
        const summaryQuery = db.query(`
            SELECT
                COUNT(DISTINCT c.id)                                     AS total_customers,
                COUNT(DISTINCT t.id)                                     AS total_transactions,
                COALESCE(SUM(t.total_amount), 0)                         AS total_credit_given,
                COALESCE(SUM(COALESCE(ps.paid, 0)), 0)                   AS total_paid_amount,
                COALESCE(SUM(t.total_amount - COALESCE(ps.paid, 0)), 0)  AS total_pending_amount,
                COUNT(DISTINCT CASE WHEN t.status = 'completed' THEN t.id END) AS completed_transactions,
                COUNT(DISTINCT CASE
                    WHEN (t.total_amount - COALESCE(ps.paid, 0)) <= 0 AND t.id IS NOT NULL
                    THEN t.id
                END) AS clear_transactions
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
            LEFT JOIN ${PAID_PER_TRANSACTION} ON ps.transaction_id = t.id
        `);

        // --- Customers with no remaining balance (fully paid) ---
        const clearCustomersQuery = db.query(`
            WITH per_customer AS (
                SELECT
                    t.customer_id,
                    COALESCE(SUM(t.total_amount), 0)                        AS total_amount,
                    COALESCE(SUM(COALESCE(ps.paid, 0)), 0)                  AS paid_amount,
                    COALESCE(SUM(t.total_amount - COALESCE(ps.paid, 0)), 0) AS remaining_amount,
                    MIN(t.payment_date)      AS first_payment_date,
                    MAX(t.next_payment_date) AS next_due_date
                FROM customer_transactions t
                LEFT JOIN ${PAID_PER_TRANSACTION} ON ps.transaction_id = t.id
                GROUP BY t.customer_id
            )
            SELECT
                c.id, c.name, c.mobile_number, c.village_city, c.district, c.state,
                pc.total_amount, pc.paid_amount, pc.remaining_amount,
                pc.first_payment_date, pc.next_due_date
            FROM customers c
            JOIN per_customer pc ON pc.customer_id = c.id
            WHERE pc.remaining_amount = 0
            ORDER BY c.created_at DESC
        `);

        // --- Customers with remaining balance (still pending) ---
        const pendingCustomersQuery = db.query(`
            WITH per_customer AS (
                SELECT
                    t.customer_id,
                    COALESCE(SUM(t.total_amount), 0)                        AS total_amount,
                    COALESCE(SUM(COALESCE(ps.paid, 0)), 0)                  AS paid_amount,
                    COALESCE(SUM(t.total_amount - COALESCE(ps.paid, 0)), 0) AS remaining_amount,
                    MIN(t.payment_date)      AS first_payment_date,
                    MAX(t.next_payment_date) AS next_due_date
                FROM customer_transactions t
                LEFT JOIN ${PAID_PER_TRANSACTION} ON ps.transaction_id = t.id
                GROUP BY t.customer_id
            )
            SELECT
                c.id, c.name, c.mobile_number, c.village_city, c.district, c.state,
                pc.total_amount, pc.paid_amount,
                pc.remaining_amount, pc.remaining_amount AS pending_amount,
                pc.first_payment_date, pc.next_due_date
            FROM customers c
            JOIN per_customer pc ON pc.customer_id = c.id
            WHERE pc.remaining_amount > 0
            ORDER BY c.created_at DESC
        `);

        // --- All customers with their totals ---
        const allCustomersQuery = db.query(`
            WITH per_customer AS (
                SELECT
                    t.customer_id,
                    COALESCE(SUM(t.total_amount), 0)                        AS total_amount,
                    COALESCE(SUM(COALESCE(ps.paid, 0)), 0)                  AS paid_amount,
                    COALESCE(SUM(t.total_amount - COALESCE(ps.paid, 0)), 0) AS remaining_amount
                FROM customer_transactions t
                LEFT JOIN ${PAID_PER_TRANSACTION} ON ps.transaction_id = t.id
                GROUP BY t.customer_id
            )
            SELECT
                c.id, c.name, c.mobile_number, c.village_city, c.district, c.state,
                COALESCE(pc.total_amount, 0)    AS total_amount,
                COALESCE(pc.paid_amount, 0)     AS paid_amount,
                COALESCE(pc.remaining_amount, 0) AS remaining_amount
            FROM customers c
            LEFT JOIN per_customer pc ON pc.customer_id = c.id
            ORDER BY c.created_at DESC
        `);

        // Run all 4 queries at the same time for speed
        const [summaryResult, clearResult, pendingResult, allResult] = await Promise.all([
            summaryQuery, clearCustomersQuery, pendingCustomersQuery, allCustomersQuery
        ]);

        const row = summaryResult.rows[0] || {};

        res.render('report', {
            user:             req.user,
            title:            'Report - AgriCrm',
            totalCustomers:   parseInt(row.total_customers)    || 0,
            totalTransactions:parseInt(row.total_transactions) || 0,
            totalPending:     parseFloat(row.total_pending_amount) || 0,
            totalClear:       parseInt(row.clear_transactions)  || 0,
            clearCustomers:   clearResult.rows   || [],
            pendingCustomers: pendingResult.rows || [],
            allCustomers:     allResult.rows     || []
        });

    } catch (err) {
        console.error('Report page error:', err);
        res.render('report', emptyReport);
    }
});

// ===================================================================
// ROUTE MOUNTING
// ===================================================================
app.use('/auth',      authRouter);       // Login, register, logout
app.use('/customers', customerRouter);   // Customer CRUD + transactions
app.use('/api/users', usersRouter);      // Dashboard API, search, stats

// Logout via GET (clears session and redirects to login)
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('agricrm.sid');
        res.redirect('/login');
    });
});

// -------------------------------------------------------------------
// 404 handler — shown when no route matches
// -------------------------------------------------------------------
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// -------------------------------------------------------------------
// Error handler — catches any unhandled errors
// -------------------------------------------------------------------
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// -------------------------------------------------------------------
// Start the server
// -------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
    console.log('=================================');
    console.log('  AgriCRM Server');
    console.log('=================================');
    console.log(`Server: http://0.0.0.0:${PORT}`);
    console.log(`Login:  http://0.0.0.0:${PORT}/login`);
    console.log('=================================');
});

module.exports = app;
