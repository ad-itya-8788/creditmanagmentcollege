require('dotenv').config();
const express = require('express');
const path = require('path');

// Import auth routes and database
const { router: authRouter, sessionMiddleware, requireAuth } = require('./routes/auth');
const customerRouter = require('./routes/customer');
const usersRouter = require('./routes/users');

const app = express();
const PORT = process.env.PORT || 3000;

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Basic middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Apply session middleware
app.use(sessionMiddleware);

// Public routes (no authentication required)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/signup', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

// Protected routes (authentication required)
app.get('/dashboard', requireAuth, async (req, res) => {
    try {
        const statsQuery = `
            SELECT
                COUNT(DISTINCT c.id) AS total_customers,
                COUNT(DISTINCT CASE WHEN c.created_at >= CURRENT_DATE THEN c.id END) AS new_customers_today,
                COUNT(DISTINCT t.id) AS total_transactions,
                COUNT(DISTINCT CASE WHEN t.status = 'active' THEN t.id END) AS active_transactions,
                COUNT(DISTINCT CASE WHEN t.status = 'completed' THEN t.id END) AS completed_transactions,
                COUNT(DISTINCT CASE WHEN t.status = 'pending' THEN t.id END) AS pending_transactions,
                COALESCE(SUM(t.total_amount), 0) AS total_credit_given,
                COALESCE(SUM(COALESCE(ps.paid, 0)), 0) AS total_paid_amount,
                COALESCE(SUM(CASE WHEN t.status = 'active' THEN t.total_amount - COALESCE(ps.paid, 0) ELSE 0 END), 0) AS total_pending_amount,
                COUNT(DISTINCT CASE
                    WHEN t.next_payment_date < CURRENT_DATE
                    AND (t.total_amount - COALESCE(ps.paid, 0)) > 0
                    AND t.status = 'active'
                    THEN t.id
                END) AS overdue_transactions
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
            LEFT JOIN (
                SELECT transaction_id, SUM(amount) AS paid FROM payment_logs GROUP BY transaction_id
            ) ps ON ps.transaction_id = t.id
        `;

        const result = await require('./dbconnect').query(statsQuery);
        const stats = result.rows[0] || {};

        res.render('dashboard', {
            user: req.user,
            stats: {
                totalCustomers: parseInt(stats.total_customers) || 0,
                newCustomersToday: parseInt(stats.new_customers_today) || 0,
                totalTransactions: parseInt(stats.total_transactions) || 0,
                activeTransactions: parseInt(stats.active_transactions) || 0,
                completedTransactions: parseInt(stats.completed_transactions) || 0,
                pendingTransactions: parseInt(stats.pending_transactions) || 0,
                totalCreditGiven: parseFloat(stats.total_credit_given) || 0,
                totalPaidAmount: parseFloat(stats.total_paid_amount) || 0,
                totalPendingAmount: parseFloat(stats.total_pending_amount) || 0,
                overdueTransactions: parseInt(stats.overdue_transactions) || 0
            }
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.render('dashboard', {
            user: req.user,
            stats: {
                totalCustomers: 0,
                newCustomersToday: 0,
                totalTransactions: 0,
                activeTransactions: 0,
                completedTransactions: 0,
                pendingTransactions: 0,
                totalCreditGiven: 0,
                totalPaidAmount: 0,
                totalPendingAmount: 0,
                overdueTransactions: 0
            }
        });
    }
});

app.get('/customers', requireAuth, async (req, res) => {
    try {
        const customersQuery = `
            WITH tx_payments AS (
                SELECT
                    t.customer_id,
                    COUNT(t.id) AS transaction_count,
                    COALESCE(SUM(t.total_amount), 0) AS total_amount,
                    COALESCE(SUM(CASE WHEN t.status = 'active' THEN t.total_amount - COALESCE(ps.paid, 0) ELSE 0 END), 0) AS total_pending_amount
                FROM customer_transactions t
                LEFT JOIN (
                    SELECT transaction_id, SUM(amount) AS paid FROM payment_logs GROUP BY transaction_id
                ) ps ON ps.transaction_id = t.id
                GROUP BY t.customer_id
            )
            SELECT
                c.id, c.name, c.mobile_number, c.village_city, c.district, c.state, c.created_at,
                COALESCE(tp.transaction_count, 0) AS transaction_count,
                COALESCE(tp.total_amount, 0) AS total_amount,
                COALESCE(tp.total_pending_amount, 0) AS total_pending_amount
            FROM customers c
            LEFT JOIN tx_payments tp ON tp.customer_id = c.id
            ORDER BY c.created_at DESC
        `;

        const result = await require('./dbconnect').query(customersQuery);
        const customers = result.rows;

        res.render('customers', { user: req.user, customers: customers });
    } catch (error) {
        console.error('Customers route error:', error);
        res.render('customers', { user: req.user, customers: [] });
    }
});

app.get('/settings', requireAuth, async (req, res) => {
    try {
        // Get user's statistics
        const statsQuery = `
            SELECT 
                COUNT(DISTINCT c.id) as total_customers,
                COUNT(t.id) as total_transactions
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
        `;

        // Get active sessions count
        const sessionsQuery = `
            SELECT COUNT(*) as session_count
            FROM session 
            WHERE sess::text LIKE '%user_id%' 
            AND expire > NOW()
        `;

        const [result, sessionResult] = await Promise.all([
            require('./dbconnect').query(statsQuery),
            require('./dbconnect').query(sessionsQuery)
        ]);

        const data = result.rows[0] || {};
        const sessionData = sessionResult.rows[0] || {};

        const customersCreatedByUser = parseInt(data.total_customers) || 0;
        const totalTransactions = parseInt(data.total_transactions) || 0;
        const activeSessions = parseInt(sessionData.session_count) || 1; // At least current session

        res.render('settings', {
            user: req.user,
            customersCreatedByUser: customersCreatedByUser,
            totalTransactions: totalTransactions,
            activeSessions: activeSessions
        });
    } catch (error) {
        console.error('Settings route error:', error);
        res.render('settings', {
            user: req.user,
            customersCreatedByUser: 0,
            totalTransactions: 0,
            activeSessions: 1
        });
    }
});

app.get('/report', requireAuth, async (req, res) => {
    try {
        // Reusable payment subquery
        const paidSub = `(SELECT transaction_id, SUM(amount) AS paid FROM payment_logs GROUP BY transaction_id) ps`;

        const reportQuery = `
            SELECT
                COUNT(DISTINCT c.id) AS total_customers,
                COUNT(DISTINCT t.id) AS total_transactions,
                COALESCE(SUM(t.total_amount), 0) AS total_credit_given,
                COALESCE(SUM(COALESCE(ps.paid, 0)), 0) AS total_paid_amount,
                COALESCE(SUM(t.total_amount - COALESCE(ps.paid, 0)), 0) AS total_pending_amount,
                COUNT(DISTINCT CASE WHEN t.status = 'completed' THEN t.id END) AS completed_transactions,
                COUNT(DISTINCT CASE WHEN (t.total_amount - COALESCE(ps.paid, 0)) <= 0 AND t.id IS NOT NULL THEN t.id END) AS clear_transactions
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
            LEFT JOIN ${paidSub} ON ps.transaction_id = t.id
        `;

        const clearCustomersQuery = `
            WITH per_customer AS (
                SELECT
                    t.customer_id,
                    COALESCE(SUM(t.total_amount), 0) AS total_amount,
                    COALESCE(SUM(COALESCE(ps.paid, 0)), 0) AS paid_amount,
                    COALESCE(SUM(t.total_amount - COALESCE(ps.paid, 0)), 0) AS remaining_amount,
                    MIN(t.payment_date) AS first_payment_date,
                    MAX(t.next_payment_date) AS next_due_date
                FROM customer_transactions t
                LEFT JOIN ${paidSub} ON ps.transaction_id = t.id
                GROUP BY t.customer_id
            )
            SELECT
                c.id, c.name, c.mobile_number, c.village_city, c.district, c.state,
                COALESCE(pc.total_amount, 0) AS total_amount,
                COALESCE(pc.paid_amount, 0) AS paid_amount,
                COALESCE(pc.remaining_amount, 0) AS remaining_amount,
                pc.first_payment_date, pc.next_due_date
            FROM customers c
            JOIN per_customer pc ON pc.customer_id = c.id
            WHERE pc.remaining_amount = 0
            ORDER BY c.created_at DESC
        `;

        const pendingCustomersQuery = `
            WITH per_customer AS (
                SELECT
                    t.customer_id,
                    COALESCE(SUM(t.total_amount), 0) AS total_amount,
                    COALESCE(SUM(COALESCE(ps.paid, 0)), 0) AS paid_amount,
                    COALESCE(SUM(t.total_amount - COALESCE(ps.paid, 0)), 0) AS remaining_amount,
                    MIN(t.payment_date) AS first_payment_date,
                    MAX(t.next_payment_date) AS next_due_date
                FROM customer_transactions t
                LEFT JOIN ${paidSub} ON ps.transaction_id = t.id
                GROUP BY t.customer_id
            )
            SELECT
                c.id, c.name, c.mobile_number, c.village_city, c.district, c.state,
                COALESCE(pc.total_amount, 0) AS total_amount,
                COALESCE(pc.paid_amount, 0) AS paid_amount,
                COALESCE(pc.remaining_amount, 0) AS remaining_amount,
                COALESCE(pc.remaining_amount, 0) AS pending_amount,
                pc.first_payment_date, pc.next_due_date
            FROM customers c
            JOIN per_customer pc ON pc.customer_id = c.id
            WHERE pc.remaining_amount > 0
            ORDER BY c.created_at DESC
        `;

        const allCustomersQuery = `
            WITH per_customer AS (
                SELECT
                    t.customer_id,
                    COALESCE(SUM(t.total_amount), 0) AS total_amount,
                    COALESCE(SUM(COALESCE(ps.paid, 0)), 0) AS paid_amount,
                    COALESCE(SUM(t.total_amount - COALESCE(ps.paid, 0)), 0) AS remaining_amount
                FROM customer_transactions t
                LEFT JOIN ${paidSub} ON ps.transaction_id = t.id
                GROUP BY t.customer_id
            )
            SELECT
                c.id, c.name, c.mobile_number, c.village_city, c.district, c.state,
                COALESCE(pc.total_amount, 0) AS total_amount,
                COALESCE(pc.paid_amount, 0) AS paid_amount,
                COALESCE(pc.remaining_amount, 0) AS remaining_amount
            FROM customers c
            LEFT JOIN per_customer pc ON pc.customer_id = c.id
            ORDER BY c.created_at DESC
        `;

        const [result, clearResult, pendingResult, allResult] = await Promise.all([
            require('./dbconnect').query(reportQuery),
            require('./dbconnect').query(clearCustomersQuery),
            require('./dbconnect').query(pendingCustomersQuery),
            require('./dbconnect').query(allCustomersQuery)
        ]);

        const data = result.rows[0] || {};
        const clearCustomers = clearResult.rows || [];
        const pendingCustomers = pendingResult.rows || [];
        const allCustomers = allResult.rows || [];

        const totalCustomers = parseInt(data.total_customers) || 0;
        const totalTransactions = parseInt(data.total_transactions) || 0;
        const totalPending = parseFloat(data.total_pending_amount) || 0;
        const totalClear = parseInt(data.clear_transactions) || 0;

        res.render('report', {
            user: req.user,
            title: 'Report - AgriCrm',
            totalCustomers: totalCustomers,
            totalTransactions: totalTransactions,
            totalPending: totalPending,
            totalClear: totalClear,
            clearCustomers: clearCustomers,
            pendingCustomers: pendingCustomers,
            allCustomers: allCustomers
        });
    } catch (error) {
        console.error('Report route error:', error);
        res.render('report', {
            user: req.user,
            title: 'Report - AgriCrm',
            totalCustomers: 0,
            totalTransactions: 0,
            totalPending: 0,
            totalClear: 0,
            clearCustomers: [],
            pendingCustomers: [],
            allCustomers: []
        });
    }
});

// Routes
app.use('/auth', authRouter);
app.use('/customers', customerRouter);
app.use('/api/users', usersRouter);

// Logout route
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        res.clearCookie('agricrm.sid');
        res.redirect('/login');
    });
});



// 404 handler
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log('=================================');
    console.log('  AgriCRM Server');
    console.log('=================================');
    console.log(`Server: http://0.0.0.0:${PORT}`);
    console.log(`Login: http://0.0.0.0:${PORT}/login`);
    console.log('=================================');
});

module.exports = app;
