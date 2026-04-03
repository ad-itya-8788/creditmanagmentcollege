const express = require('express');
const pool = require('../../dbconnect');
const { requireAuth } = require('../auth');

const router = express.Router();

// Shared CTE for per-customer aggregates
const customerSummaryCTE = `
    WITH tx_payments AS (
        SELECT
            t.customer_id,
            COUNT(t.id) AS transaction_count,
            COALESCE(SUM(t.total_amount), 0) AS total_amount,
            COALESCE(SUM(COALESCE(ps.paid, 0)), 0) AS paid_amount,
            COALESCE(SUM(t.total_amount - COALESCE(ps.paid, 0)), 0) AS pending_amount,
            COUNT(CASE WHEN t.status = 'completed' THEN 1 END) AS completed_transactions,
            COUNT(CASE WHEN t.status = 'active' THEN 1 END) AS active_transactions,
            COUNT(CASE
                WHEN t.next_payment_date < CURRENT_DATE
                AND (t.total_amount - COALESCE(ps.paid, 0)) > 0
                AND t.status = 'active'
                THEN 1
            END) AS overdue_transactions,
            MIN(t.payment_date) AS first_payment_date,
            MAX(t.next_payment_date) AS next_due_date
        FROM customer_transactions t
        LEFT JOIN (
            SELECT transaction_id, SUM(amount) AS paid
            FROM payment_logs
            GROUP BY transaction_id
        ) ps ON ps.transaction_id = t.id
        GROUP BY t.customer_id
    )
`;

// GET /api/users/recent-customers
router.get('/recent-customers', requireAuth, async (req, res) => {
    try {
        const { limit = 5 } = req.query;

        const query = `
            ${customerSummaryCTE}
            SELECT
                c.id, c.name, c.mobile_number, c.village_city, c.district, c.created_at,
                COALESCE(tp.transaction_count, 0) AS transaction_count,
                COALESCE(tp.total_amount, 0) AS total_amount,
                COALESCE(tp.pending_amount, 0) AS pending_amount
            FROM customers c
            LEFT JOIN tx_payments tp ON tp.customer_id = c.id
            ORDER BY c.created_at DESC
            LIMIT $1
        `;

        const result = await pool.query(query, [limit]);
        res.json({ success: true, customers: result.rows });

    } catch (error) {
        console.error('Error fetching recent customers:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// GET /api/users/search-customers
router.get('/search-customers', requireAuth, async (req, res) => {
    try {
        const { query: searchQuery = '', type = 'all', limit = 10 } = req.query;

        let whereClause = '';
        let queryParams = [];

        if (searchQuery) {
            if (type === 'name') {
                whereClause = 'WHERE c.name ILIKE $1';
                queryParams.push(`%${searchQuery}%`);
            } else if (type === 'phone') {
                whereClause = 'WHERE c.mobile_number ILIKE $1';
                queryParams.push(`%${searchQuery}%`);
            } else {
                whereClause = 'WHERE (c.name ILIKE $1 OR c.mobile_number ILIKE $1)';
                queryParams.push(`%${searchQuery}%`);
            }
        }

        queryParams.push(limit);
        const limitParam = `$${queryParams.length}`;

        const finalQuery = `
            ${customerSummaryCTE}
            SELECT
                c.id, c.name, c.mobile_number, c.village_city, c.district, c.state, c.created_at,
                COALESCE(tp.transaction_count, 0) AS transaction_count,
                COALESCE(tp.total_amount, 0) AS total_amount,
                COALESCE(tp.pending_amount, 0) AS pending_amount,
                CASE
                    WHEN COALESCE(tp.pending_amount, 0) = 0 AND COALESCE(tp.transaction_count, 0) > 0 THEN true
                    ELSE false
                END AS is_clear
            FROM customers c
            LEFT JOIN tx_payments tp ON tp.customer_id = c.id
            ${whereClause}
            ORDER BY c.name
            LIMIT ${limitParam}
        `;

        const result = await pool.query(finalQuery, queryParams);
        res.json({ success: true, customers: result.rows, total: result.rows.length });

    } catch (error) {
        console.error('Error searching customers:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// GET /api/users/customer/:id
router.get('/customer/:id', requireAuth, async (req, res) => {
    try {
        const customerId = parseInt(req.params.id);

        const customerQuery = `
            SELECT id, name, mobile_number, village_city, district, state,
                   complete_address, pincode, created_at, updated_at
            FROM customers WHERE id = $1
        `;

        const transactionQuery = `
            SELECT
                COUNT(t.id) AS transaction_count,
                COALESCE(SUM(t.total_amount), 0) AS total_amount,
                COALESCE(SUM(COALESCE(ps.paid, 0)), 0) AS paid_amount,
                COALESCE(SUM(t.total_amount - COALESCE(ps.paid, 0)), 0) AS pending_amount,
                COUNT(CASE WHEN t.status = 'completed' THEN 1 END) AS completed_transactions,
                COUNT(CASE WHEN t.status = 'active' THEN 1 END) AS active_transactions,
                COUNT(CASE
                    WHEN t.next_payment_date < CURRENT_DATE
                    AND (t.total_amount - COALESCE(ps.paid, 0)) > 0
                    AND t.status = 'active'
                    THEN 1
                END) AS overdue_transactions,
                MIN(t.payment_date) AS first_payment_date,
                MAX(t.next_payment_date) AS next_due_date
            FROM customer_transactions t
            LEFT JOIN (
                SELECT transaction_id, SUM(amount) AS paid
                FROM payment_logs GROUP BY transaction_id
            ) ps ON ps.transaction_id = t.id
            WHERE t.customer_id = $1
        `;

        const recentTransactionsQuery = `
            SELECT
                t.id, t.transaction_type, t.product_service, t.total_amount,
                t.payment_date, t.next_payment_date, t.notes, t.status, t.created_at,
                COALESCE(SUM(p.amount), 0) AS paid_amount,
                t.total_amount - COALESCE(SUM(p.amount), 0) AS remaining_amount
            FROM customer_transactions t
            LEFT JOIN payment_logs p ON p.transaction_id = t.id
            WHERE t.customer_id = $1
            GROUP BY t.id
            ORDER BY t.created_at DESC
            LIMIT 5
        `;

        const [customerResult, transactionResult, recentResult] = await Promise.all([
            pool.query(customerQuery, [customerId]),
            pool.query(transactionQuery, [customerId]),
            pool.query(recentTransactionsQuery, [customerId])
        ]);

        if (customerResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Customer not found' });
        }

        const customer = customerResult.rows[0];
        const ts = transactionResult.rows[0] || {};

        res.json({
            success: true,
            customer: {
                ...customer,
                transactionCount: parseInt(ts.transaction_count) || 0,
                totalAmount: parseFloat(ts.total_amount) || 0,
                paidAmount: parseFloat(ts.paid_amount) || 0,
                pendingAmount: parseFloat(ts.pending_amount) || 0,
                completedTransactions: parseInt(ts.completed_transactions) || 0,
                activeTransactions: parseInt(ts.active_transactions) || 0,
                overdueTransactions: parseInt(ts.overdue_transactions) || 0,
                firstPaymentDate: ts.first_payment_date,
                nextDueDate: ts.next_due_date,
                hasOverdue: parseInt(ts.overdue_transactions) > 0,
                isClear: (parseFloat(ts.pending_amount) || 0) === 0 && (parseInt(ts.transaction_count) || 0) > 0
            },
            recentTransactions: recentResult.rows
        });

    } catch (error) {
        console.error('Error fetching customer details:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// GET /api/users/customers/statistics
router.get('/customers/statistics', requireAuth, async (req, res) => {
    try {
        const { filter = 'all-time' } = req.query;

        let dateFilter = '';
        switch (filter) {
            case '24-hours': dateFilter = "WHERE c.created_at >= NOW() - INTERVAL '24 hours'"; break;
            case '7-days':   dateFilter = "WHERE c.created_at >= NOW() - INTERVAL '7 days'"; break;
            case '30-days':  dateFilter = "WHERE c.created_at >= NOW() - INTERVAL '30 days'"; break;
            default:         dateFilter = '';
        }

        const query = `
            SELECT
                COUNT(DISTINCT c.id) AS total_customers,
                COUNT(CASE WHEN c.created_at >= CURRENT_DATE THEN 1 END) AS customers_today,
                COUNT(DISTINCT t.id) AS total_transactions,
                COALESCE(SUM(t.total_amount), 0) AS total_credit_given,
                COALESCE(SUM(COALESCE(ps.paid, 0)), 0) AS total_paid_amount,
                COALESCE(SUM(t.total_amount - COALESCE(ps.paid, 0)), 0) AS total_pending_amount
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
            LEFT JOIN (
                SELECT transaction_id, SUM(amount) AS paid
                FROM payment_logs GROUP BY transaction_id
            ) ps ON ps.transaction_id = t.id
            ${dateFilter}
        `;

        const result = await pool.query(query);
        const stats = result.rows[0];

        res.json({
            success: true,
            statistics: {
                totalCustomers: parseInt(stats.total_customers) || 0,
                customersToday: parseInt(stats.customers_today) || 0,
                totalTransactions: parseInt(stats.total_transactions) || 0,
                totalCreditGiven: parseFloat(stats.total_credit_given) || 0,
                totalPaidAmount: parseFloat(stats.total_paid_amount) || 0,
                totalPendingAmount: parseFloat(stats.total_pending_amount) || 0
            },
            filter: filter
        });

    } catch (error) {
        console.error('Error fetching customer statistics:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

module.exports = router;
