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
        // Get comprehensive dashboard statistics
        const statsQuery = `
            SELECT 
                -- Customer Statistics
                COUNT(DISTINCT c.id) as total_customers,
                COUNT(DISTINCT CASE 
                    WHEN c.created_at >= CURRENT_DATE 
                    THEN c.id 
                END) as new_customers_today,
                
                -- Transaction Statistics
                COUNT(t.id) as total_transactions,
                COUNT(CASE WHEN t.status = 'active' THEN 1 END) as active_transactions,
                COUNT(CASE WHEN t.status = 'completed' THEN 1 END) as completed_transactions,
                COUNT(CASE WHEN t.status = 'pending' THEN 1 END) as pending_transactions,
                
                -- Financial Statistics
                COALESCE(SUM(t.total_amount), 0) as total_credit_given,
                COALESCE(SUM(t.paid_amount), 0) as total_paid_amount,
                COALESCE(SUM(t.remaining_amount), 0) as total_pending_amount,
                
                -- Overdue Transactions
                COUNT(CASE 
                    WHEN t.next_payment_date < CURRENT_DATE 
                    AND t.remaining_amount > 0 
                    AND t.status = 'active'
                    THEN 1 
                END) as overdue_transactions
                
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
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
        // Get customers with transaction data
        const customersQuery = `
            SELECT 
                c.id, c.name, c.mobile_number, c.village_city, c.district, c.state,
                c.created_at,
                COUNT(t.id) as transaction_count,
                COALESCE(SUM(t.total_amount), 0) as total_amount,
                COALESCE(SUM(CASE WHEN t.status = 'active' THEN t.remaining_amount ELSE 0 END), 0) as total_pending_amount
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
            GROUP BY c.id, c.name, c.mobile_number, c.village_city, c.district, c.state, c.created_at
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
        // Get comprehensive report statistics
        const reportQuery = `
            SELECT 
                COUNT(DISTINCT c.id) as total_customers,
                COUNT(t.id) as total_transactions,
                COALESCE(SUM(t.total_amount), 0) as total_credit_given,
                COALESCE(SUM(t.paid_amount), 0) as total_paid_amount,
                COALESCE(SUM(t.remaining_amount), 0) as total_pending_amount,
                COUNT(CASE WHEN t.status = 'completed' THEN 1 END) as completed_transactions,
                COUNT(CASE WHEN t.remaining_amount = 0 AND t.id IS NOT NULL THEN 1 END) as clear_transactions
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
        `;

        // Get clear customers (customers with no pending amounts)
        const clearCustomersQuery = `
            SELECT 
                c.id, c.name, c.mobile_number, c.village_city, c.district, c.state,
                COALESCE(SUM(t.total_amount), 0) as total_amount,
                COALESCE(SUM(t.paid_amount), 0) as paid_amount,
                COALESCE(SUM(t.remaining_amount), 0) as remaining_amount,
                MIN(t.payment_date) as first_payment_date,
                MAX(t.next_payment_date) as next_due_date
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
            GROUP BY c.id, c.name, c.mobile_number, c.village_city, c.district, c.state
            HAVING COALESCE(SUM(t.remaining_amount), 0) = 0
            ORDER BY c.created_at DESC
        `;

        // Get pending customers (customers with pending amounts)
        const pendingCustomersQuery = `
            SELECT 
                c.id, c.name, c.mobile_number, c.village_city, c.district, c.state,
                COALESCE(SUM(t.total_amount), 0) as total_amount,
                COALESCE(SUM(t.paid_amount), 0) as paid_amount,
                COALESCE(SUM(t.remaining_amount), 0) as remaining_amount,
                COALESCE(SUM(t.remaining_amount), 0) as pending_amount,
                MIN(t.payment_date) as first_payment_date,
                MAX(t.next_payment_date) as next_due_date
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
            GROUP BY c.id, c.name, c.mobile_number, c.village_city, c.district, c.state
            HAVING COALESCE(SUM(t.remaining_amount), 0) > 0
            ORDER BY c.created_at DESC
        `;

        // Get all customers
        const allCustomersQuery = `
            SELECT 
                c.id, c.name, c.mobile_number, c.village_city, c.district, c.state,
                COALESCE(SUM(t.total_amount), 0) as total_amount,
                COALESCE(SUM(t.paid_amount), 0) as paid_amount,
                COALESCE(SUM(t.remaining_amount), 0) as remaining_amount
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
            GROUP BY c.id, c.name, c.mobile_number, c.village_city, c.district, c.state
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
