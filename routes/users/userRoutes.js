const express = require('express');
const path = require('path');
const pool = require('../../dbconnect');
const { requireAuth } = require('../auth');

const router = express.Router();

// Reusable payment subquery
const paymentSubquery = `(
    SELECT transaction_id, SUM(amount) AS paid
    FROM payment_logs
    GROUP BY transaction_id
) ps`;

// GET /api/users/dashboard-stats
router.get('/dashboard-stats', requireAuth, async (req, res) => {
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
                CASE
                    WHEN COALESCE(SUM(t.total_amount), 0) > 0
                    THEN ROUND((COALESCE(SUM(COALESCE(ps.paid, 0)), 0)::DECIMAL / COALESCE(SUM(t.total_amount), 0)::DECIMAL) * 100, 1)
                    ELSE 0
                END AS success_rate,
                CASE
                    WHEN COUNT(DISTINCT t.id) > 0
                    THEN ROUND((COUNT(DISTINCT CASE WHEN t.status = 'completed' THEN t.id END)::DECIMAL / COUNT(DISTINCT t.id)::DECIMAL) * 100, 1)
                    ELSE 0
                END AS completion_rate,
                COUNT(DISTINCT CASE
                    WHEN t.next_payment_date < CURRENT_DATE
                    AND (t.total_amount - COALESCE(ps.paid, 0)) > 0
                    AND t.status = 'active'
                    THEN t.id
                END) AS overdue_transactions
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
            LEFT JOIN ${paymentSubquery} ON ps.transaction_id = t.id
        `;

        const result = await pool.query(statsQuery);
        const stats = result.rows[0];

        res.json({
            success: true,
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
                successRate: parseFloat(stats.success_rate) || 0,
                completionRate: parseFloat(stats.completion_rate) || 0,
                overdueTransactions: parseInt(stats.overdue_transactions) || 0
            }
        });

    } catch (error) {
        console.error('Error fetching dashboard stats:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// GET /api/users/profile-stats
router.get('/profile-stats', requireAuth, async (req, res) => {
    try {
        const userId = req.session.admin_id;

        const userQuery = `
            SELECT admin_id, shop_name, owner_name, email, owner_phone, shop_address, created_at, updated_at
            FROM admin WHERE admin_id = $1
        `;

        const countsQuery = `
            SELECT
                COUNT(DISTINCT c.id) AS total_customers,
                COUNT(DISTINCT t.id) AS total_transactions,
                COUNT(CASE WHEN c.created_at >= CURRENT_DATE THEN 1 END) AS customers_today
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
        `;

        const [userResult, countsResult] = await Promise.all([
            pool.query(userQuery, [userId]),
            pool.query(countsQuery)
        ]);

        if (userResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const user = userResult.rows[0];
        const counts = countsResult.rows[0];

        res.json({
            success: true,
            user: {
                admin_id: user.admin_id,
                shop_name: user.shop_name,
                owner_name: user.owner_name,
                email: user.email,
                owner_phone: user.owner_phone,
                shop_address: user.shop_address,
                created_at: user.created_at,
                updated_at: user.updated_at
            },
            stats: {
                totalCustomers: parseInt(counts.total_customers) || 0,
                totalTransactions: parseInt(counts.total_transactions) || 0,
                customersToday: parseInt(counts.customers_today) || 0
            }
        });

    } catch (error) {
        console.error('Error fetching profile stats:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// GET /api/users/activity
router.get('/activity', requireAuth, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;

        const transactionsQuery = `
            SELECT
                t.id, t.transaction_type, t.total_amount, t.status, t.created_at,
                COALESCE(SUM(p.amount), 0) AS paid_amount,
                t.total_amount - COALESCE(SUM(p.amount), 0) AS remaining_amount,
                c.name AS customer_name, c.mobile_number AS customer_phone
            FROM customer_transactions t
            JOIN customers c ON t.customer_id = c.id
            LEFT JOIN payment_logs p ON p.transaction_id = t.id
            GROUP BY t.id, c.name, c.mobile_number
            ORDER BY t.created_at DESC
            LIMIT $1
        `;

        const customersQuery = `
            SELECT
                c.id, c.name, c.mobile_number, c.village_city, c.created_at,
                COUNT(t.id) AS transaction_count
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
            GROUP BY c.id, c.name, c.mobile_number, c.village_city, c.created_at
            ORDER BY c.created_at DESC
            LIMIT $1
        `;

        const [transactionsResult, customersResult] = await Promise.all([
            pool.query(transactionsQuery, [limit]),
            pool.query(customersQuery, [limit])
        ]);

        res.json({
            success: true,
            recentTransactions: transactionsResult.rows,
            recentCustomers: customersResult.rows
        });

    } catch (error) {
        console.error('Error fetching activity:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// GET /api/users/summary
router.get('/summary', requireAuth, async (req, res) => {
    try {
        const userId = req.session.admin_id;

        const userQuery = `
            SELECT admin_id, shop_name, owner_name, email, created_at
            FROM admin WHERE admin_id = $1
        `;

        const summaryQuery = `
            SELECT
                COUNT(DISTINCT c.id) AS total_customers,
                COUNT(DISTINCT t.id) AS total_transactions,
                COALESCE(SUM(t.total_amount), 0) AS total_credit,
                COALESCE(SUM(COALESCE(ps.paid, 0)), 0) AS total_paid,
                COALESCE(SUM(t.total_amount - COALESCE(ps.paid, 0)), 0) AS total_pending,
                COUNT(DISTINCT CASE WHEN t.status = 'completed' THEN t.id END) AS completed_transactions,
                COUNT(DISTINCT CASE WHEN t.status = 'active' THEN t.id END) AS active_transactions
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
            LEFT JOIN ${paymentSubquery} ON ps.transaction_id = t.id
        `;

        const [userResult, summaryResult] = await Promise.all([
            pool.query(userQuery, [userId]),
            pool.query(summaryQuery)
        ]);

        if (userResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const user = userResult.rows[0];
        const summary = summaryResult.rows[0];

        res.json({
            success: true,
            user: {
                admin_id: user.admin_id,
                shop_name: user.shop_name,
                owner_name: user.owner_name,
                email: user.email,
                created_at: user.created_at
            },
            summary: {
                totalCustomers: parseInt(summary.total_customers) || 0,
                totalTransactions: parseInt(summary.total_transactions) || 0,
                totalCredit: parseFloat(summary.total_credit) || 0,
                totalPaid: parseFloat(summary.total_paid) || 0,
                totalPending: parseFloat(summary.total_pending) || 0,
                completedTransactions: parseInt(summary.completed_transactions) || 0,
                activeTransactions: parseInt(summary.active_transactions) || 0
            }
        });

    } catch (error) {
        console.error('Error fetching user summary:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

module.exports = router;
