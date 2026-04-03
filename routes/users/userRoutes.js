const express = require('express');
const pool = require('../../dbconnect');
const { requireAuth } = require('../auth');

const router = express.Router();

// -------------------------------------------------------------------
// SQL helper: sums total payments per transaction
// Used in JOINs to compute paid/remaining per transaction
// -------------------------------------------------------------------
const PAID_PER_TRANSACTION = `(
    SELECT transaction_id, SUM(amount) AS paid
    FROM payment_logs
    GROUP BY transaction_id
) ps`;

// -------------------------------------------------------------------
// GET /api/users/dashboard-stats
// Returns summary counts and totals for the dashboard cards
// -------------------------------------------------------------------
router.get('/dashboard-stats', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                COUNT(DISTINCT c.id) AS total_customers,
                -- Customers added today
                COUNT(DISTINCT CASE WHEN c.created_at >= CURRENT_DATE THEN c.id END) AS new_customers_today,
                COUNT(DISTINCT t.id)                               AS total_transactions,
                COUNT(DISTINCT CASE WHEN t.status = 'active'    THEN t.id END) AS active_transactions,
                COUNT(DISTINCT CASE WHEN t.status = 'completed' THEN t.id END) AS completed_transactions,
                COUNT(DISTINCT CASE WHEN t.status = 'pending'   THEN t.id END) AS pending_transactions,
                COALESCE(SUM(t.total_amount), 0)                               AS total_credit_given,
                COALESCE(SUM(COALESCE(ps.paid, 0)), 0)                         AS total_paid_amount,
                -- Pending = only count active transactions that still have a balance
                COALESCE(SUM(
                    CASE WHEN t.status = 'active'
                    THEN t.total_amount - COALESCE(ps.paid, 0)
                    ELSE 0 END
                ), 0) AS total_pending_amount,
                -- Success rate = paid / total credit given (as a percentage)
                CASE
                    WHEN COALESCE(SUM(t.total_amount), 0) > 0
                    THEN ROUND(
                        (COALESCE(SUM(COALESCE(ps.paid, 0)), 0)::DECIMAL
                         / COALESCE(SUM(t.total_amount), 0)::DECIMAL) * 100, 1)
                    ELSE 0
                END AS success_rate,
                -- Completion rate = completed transactions / total transactions
                CASE
                    WHEN COUNT(DISTINCT t.id) > 0
                    THEN ROUND(
                        (COUNT(DISTINCT CASE WHEN t.status = 'completed' THEN t.id END)::DECIMAL
                         / COUNT(DISTINCT t.id)::DECIMAL) * 100, 1)
                    ELSE 0
                END AS completion_rate,
                -- Overdue = active, past due date, still has balance
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

        const row = result.rows[0];

        res.json({
            success: true,
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
                successRate:          parseFloat(row.success_rate)         || 0,
                completionRate:       parseFloat(row.completion_rate)      || 0,
                overdueTransactions:  parseInt(row.overdue_transactions)   || 0
            }
        });

    } catch (err) {
        console.error('Error fetching dashboard stats:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// -------------------------------------------------------------------
// GET /api/users/profile-stats
// Returns the logged-in admin's profile info + basic customer/tx counts
// -------------------------------------------------------------------
router.get('/profile-stats', requireAuth, async (req, res) => {
    try {
        const adminId = req.session.admin_id;

        // Get admin info and customer/transaction counts at the same time
        const [adminResult, countsResult] = await Promise.all([
            pool.query(`
                SELECT admin_id, shop_name, owner_name, email,
                       owner_phone, shop_address, created_at, updated_at
                FROM admin WHERE admin_id = $1
            `, [adminId]),

            pool.query(`
                SELECT
                    COUNT(DISTINCT c.id) AS total_customers,
                    COUNT(DISTINCT t.id) AS total_transactions,
                    COUNT(CASE WHEN c.created_at >= CURRENT_DATE THEN 1 END) AS customers_today
                FROM customers c
                LEFT JOIN customer_transactions t ON c.id = t.customer_id
            `)
        ]);

        if (adminResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Admin not found' });
        }

        const admin  = adminResult.rows[0];
        const counts = countsResult.rows[0];

        res.json({
            success: true,
            user: {
                admin_id:     admin.admin_id,
                shop_name:    admin.shop_name,
                owner_name:   admin.owner_name,
                email:        admin.email,
                owner_phone:  admin.owner_phone,
                shop_address: admin.shop_address,
                created_at:   admin.created_at,
                updated_at:   admin.updated_at
            },
            stats: {
                totalCustomers:    parseInt(counts.total_customers)    || 0,
                totalTransactions: parseInt(counts.total_transactions) || 0,
                customersToday:    parseInt(counts.customers_today)    || 0
            }
        });

    } catch (err) {
        console.error('Error fetching profile stats:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// -------------------------------------------------------------------
// GET /api/users/activity
// Returns recent transactions and recently added customers
// Query param: limit (default 10)
// -------------------------------------------------------------------
router.get('/activity', requireAuth, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;

        // Get recent transactions with paid/remaining amounts
        const txQuery = pool.query(`
            SELECT
                t.id, t.transaction_type, t.total_amount, t.status, t.created_at,
                COALESCE(SUM(p.amount), 0)                  AS paid_amount,
                t.total_amount - COALESCE(SUM(p.amount), 0) AS remaining_amount,
                c.name AS customer_name, c.mobile_number AS customer_phone
            FROM customer_transactions t
            JOIN customers c ON t.customer_id = c.id
            LEFT JOIN payment_logs p ON p.transaction_id = t.id
            GROUP BY t.id, c.name, c.mobile_number
            ORDER BY t.created_at DESC
            LIMIT $1
        `, [limit]);

        // Get recently added customers with their transaction count
        const customerQuery = pool.query(`
            SELECT
                c.id, c.name, c.mobile_number, c.village_city, c.created_at,
                COUNT(t.id) AS transaction_count
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
            GROUP BY c.id, c.name, c.mobile_number, c.village_city, c.created_at
            ORDER BY c.created_at DESC
            LIMIT $1
        `, [limit]);

        const [txResult, customerResult] = await Promise.all([txQuery, customerQuery]);

        res.json({
            success: true,
            recentTransactions: txResult.rows,
            recentCustomers:    customerResult.rows
        });

    } catch (err) {
        console.error('Error fetching activity:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// -------------------------------------------------------------------
// GET /api/users/summary
// Returns admin info + an overall credit/payment summary
// -------------------------------------------------------------------
router.get('/summary', requireAuth, async (req, res) => {
    try {
        const adminId = req.session.admin_id;

        // Get admin info and overall summary at the same time
        const [adminResult, summaryResult] = await Promise.all([
            pool.query(`
                SELECT admin_id, shop_name, owner_name, email, created_at
                FROM admin WHERE admin_id = $1
            `, [adminId]),

            pool.query(`
                SELECT
                    COUNT(DISTINCT c.id)                                            AS total_customers,
                    COUNT(DISTINCT t.id)                                            AS total_transactions,
                    COALESCE(SUM(t.total_amount), 0)                                AS total_credit,
                    COALESCE(SUM(COALESCE(ps.paid, 0)), 0)                          AS total_paid,
                    COALESCE(SUM(t.total_amount - COALESCE(ps.paid, 0)), 0)         AS total_pending,
                    COUNT(DISTINCT CASE WHEN t.status = 'completed' THEN t.id END)  AS completed_transactions,
                    COUNT(DISTINCT CASE WHEN t.status = 'active'    THEN t.id END)  AS active_transactions
                FROM customers c
                LEFT JOIN customer_transactions t ON c.id = t.customer_id
                LEFT JOIN ${PAID_PER_TRANSACTION} ON ps.transaction_id = t.id
            `)
        ]);

        if (adminResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Admin not found' });
        }

        const admin   = adminResult.rows[0];
        const summary = summaryResult.rows[0];

        res.json({
            success: true,
            user: {
                admin_id:   admin.admin_id,
                shop_name:  admin.shop_name,
                owner_name: admin.owner_name,
                email:      admin.email,
                created_at: admin.created_at
            },
            summary: {
                totalCustomers:       parseInt(summary.total_customers)        || 0,
                totalTransactions:    parseInt(summary.total_transactions)     || 0,
                totalCredit:          parseFloat(summary.total_credit)         || 0,
                totalPaid:            parseFloat(summary.total_paid)           || 0,
                totalPending:         parseFloat(summary.total_pending)        || 0,
                completedTransactions:parseInt(summary.completed_transactions) || 0,
                activeTransactions:   parseInt(summary.active_transactions)    || 0
            }
        });

    } catch (err) {
        console.error('Error fetching user summary:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

module.exports = router;
