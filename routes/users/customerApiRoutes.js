const express = require('express');
const pool = require('../../dbconnect');
const { requireAuth } = require('../auth');

const router = express.Router();

// -------------------------------------------------------------------
// SQL helper: sums total payments per transaction
// Used in JOINs to compute how much has been paid for each transaction
// -------------------------------------------------------------------
const PAID_PER_TRANSACTION = `(
    SELECT transaction_id, SUM(amount) AS paid
    FROM payment_logs
    GROUP BY transaction_id
) ps`;

// -------------------------------------------------------------------
// SQL helper: a reusable WITH block (CTE) that summarizes each
// customer's transactions — count, total, paid, pending, and overdue
// -------------------------------------------------------------------
const CUSTOMER_SUMMARY_CTE = `
    WITH tx_payments AS (
        SELECT
            t.customer_id,
            COUNT(t.id)                                             AS transaction_count,
            COALESCE(SUM(t.total_amount), 0)                        AS total_amount,
            COALESCE(SUM(COALESCE(ps.paid, 0)), 0)                  AS paid_amount,
            COALESCE(SUM(t.total_amount - COALESCE(ps.paid, 0)), 0) AS pending_amount,
            COUNT(CASE WHEN t.status = 'completed' THEN 1 END)      AS completed_transactions,
            COUNT(CASE WHEN t.status = 'active' THEN 1 END)         AS active_transactions,
            -- Overdue = active transaction whose next payment date has passed and still has balance
            COUNT(CASE
                WHEN t.next_payment_date < CURRENT_DATE
                AND (t.total_amount - COALESCE(ps.paid, 0)) > 0
                AND t.status = 'active'
                THEN 1
            END) AS overdue_transactions,
            MIN(t.payment_date)      AS first_payment_date,
            MAX(t.next_payment_date) AS next_due_date
        FROM customer_transactions t
        LEFT JOIN ${PAID_PER_TRANSACTION} ON ps.transaction_id = t.id
        GROUP BY t.customer_id
    )
`;

// -------------------------------------------------------------------
// GET /api/users/recent-customers
// Returns the most recently added customers with their credit summary
// Query param: limit (default 5)
// -------------------------------------------------------------------
router.get('/recent-customers', requireAuth, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 5;

        const result = await pool.query(`
            ${CUSTOMER_SUMMARY_CTE}
            SELECT
                c.id, c.name, c.mobile_number, c.village_city, c.district, c.created_at,
                COALESCE(tp.transaction_count, 0) AS transaction_count,
                COALESCE(tp.total_amount, 0)      AS total_amount,
                COALESCE(tp.pending_amount, 0)    AS pending_amount
            FROM customers c
            LEFT JOIN tx_payments tp ON tp.customer_id = c.id
            ORDER BY c.created_at DESC
            LIMIT $1
        `, [limit]);

        res.json({ success: true, customers: result.rows });

    } catch (err) {
        console.error('Error fetching recent customers:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// -------------------------------------------------------------------
// GET /api/users/search-customers
// Searches customers by name and/or phone number
// Query params: query (search text), type (name/phone/all), limit
// -------------------------------------------------------------------
router.get('/search-customers', requireAuth, async (req, res) => {
    try {
        const searchText = req.query.query || '';
        const searchType = req.query.type  || 'all';
        const limit      = parseInt(req.query.limit) || 10;

        // Build the WHERE clause based on search type
        let whereClause = '';
        let params = [];

        if (searchText) {
            if (searchType === 'name') {
                whereClause = 'WHERE c.name ILIKE $1';
            } else if (searchType === 'phone') {
                whereClause = 'WHERE c.mobile_number ILIKE $1';
            } else {
                // Default: search both name and phone
                whereClause = 'WHERE (c.name ILIKE $1 OR c.mobile_number ILIKE $1)';
            }
            params.push(`%${searchText}%`);
        }

        params.push(limit);
        const limitParam = `$${params.length}`;

        const result = await pool.query(`
            ${CUSTOMER_SUMMARY_CTE}
            SELECT
                c.id, c.name, c.mobile_number, c.village_city, c.district, c.state, c.created_at,
                COALESCE(tp.transaction_count, 0) AS transaction_count,
                COALESCE(tp.total_amount, 0)      AS total_amount,
                COALESCE(tp.pending_amount, 0)    AS pending_amount,
                -- is_clear = has transactions and no pending balance
                CASE
                    WHEN COALESCE(tp.pending_amount, 0) = 0
                     AND COALESCE(tp.transaction_count, 0) > 0
                    THEN true
                    ELSE false
                END AS is_clear
            FROM customers c
            LEFT JOIN tx_payments tp ON tp.customer_id = c.id
            ${whereClause}
            ORDER BY c.name
            LIMIT ${limitParam}
        `, params);

        res.json({ success: true, customers: result.rows, total: result.rows.length });

    } catch (err) {
        console.error('Error searching customers:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// -------------------------------------------------------------------
// GET /api/users/customer/:id
// Returns full details for a single customer:
// - Basic info (name, phone, address)
// - Credit summary (total, paid, remaining, overdue)
// - 5 most recent transactions
// -------------------------------------------------------------------
router.get('/customer/:id', requireAuth, async (req, res) => {
    try {
        const customerId = parseInt(req.params.id);

        // Query 1: Basic customer info
        const customerQuery = pool.query(`
            SELECT id, name, mobile_number, village_city, district, state,
                   complete_address, pincode, created_at, updated_at
            FROM customers WHERE id = $1
        `, [customerId]);

        // Query 2: Aggregated transaction stats for this customer
        const statsQuery = pool.query(`
            SELECT
                COUNT(t.id)                                             AS transaction_count,
                COALESCE(SUM(t.total_amount), 0)                        AS total_amount,
                COALESCE(SUM(COALESCE(ps.paid, 0)), 0)                  AS paid_amount,
                COALESCE(SUM(t.total_amount - COALESCE(ps.paid, 0)), 0) AS pending_amount,
                COUNT(CASE WHEN t.status = 'completed' THEN 1 END)      AS completed_transactions,
                COUNT(CASE WHEN t.status = 'active' THEN 1 END)         AS active_transactions,
                COUNT(CASE
                    WHEN t.next_payment_date < CURRENT_DATE
                    AND (t.total_amount - COALESCE(ps.paid, 0)) > 0
                    AND t.status = 'active'
                    THEN 1
                END) AS overdue_transactions,
                MIN(t.payment_date)      AS first_payment_date,
                MAX(t.next_payment_date) AS next_due_date
            FROM customer_transactions t
            LEFT JOIN ${PAID_PER_TRANSACTION} ON ps.transaction_id = t.id
            WHERE t.customer_id = $1
        `, [customerId]);

        // Query 3: Last 5 transactions with paid/remaining
        const recentQuery = pool.query(`
            SELECT
                t.id, t.transaction_type, t.product_service, t.total_amount,
                t.payment_date, t.next_payment_date, t.notes, t.status, t.created_at,
                COALESCE(SUM(p.amount), 0)                  AS paid_amount,
                t.total_amount - COALESCE(SUM(p.amount), 0) AS remaining_amount
            FROM customer_transactions t
            LEFT JOIN payment_logs p ON p.transaction_id = t.id
            WHERE t.customer_id = $1
            GROUP BY t.id
            ORDER BY t.created_at DESC
            LIMIT 5
        `, [customerId]);

        // Run all 3 queries at the same time
        const [customerResult, statsResult, recentResult] = await Promise.all([
            customerQuery, statsQuery, recentQuery
        ]);

        if (customerResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Customer not found' });
        }

        const customer = customerResult.rows[0];
        const stats    = statsResult.rows[0] || {};

        const pendingAmount      = parseFloat(stats.pending_amount) || 0;
        const transactionCount   = parseInt(stats.transaction_count) || 0;
        const overdueTransactions = parseInt(stats.overdue_transactions) || 0;

        res.json({
            success: true,
            customer: {
                ...customer,
                transactionCount,
                totalAmount:          parseFloat(stats.total_amount)          || 0,
                paidAmount:           parseFloat(stats.paid_amount)           || 0,
                pendingAmount,
                completedTransactions:parseInt(stats.completed_transactions)  || 0,
                activeTransactions:   parseInt(stats.active_transactions)     || 0,
                overdueTransactions,
                firstPaymentDate:     stats.first_payment_date,
                nextDueDate:          stats.next_due_date,
                hasOverdue:           overdueTransactions > 0,
                isClear:              pendingAmount === 0 && transactionCount > 0
            },
            recentTransactions: recentResult.rows
        });

    } catch (err) {
        console.error('Error fetching customer details:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// -------------------------------------------------------------------
// GET /api/users/customers/statistics
// Returns overall credit statistics across all customers
// Query param: filter = all-time | 24-hours | 7-days | 30-days
// -------------------------------------------------------------------
router.get('/customers/statistics', requireAuth, async (req, res) => {
    try {
        const filter = req.query.filter || 'all-time';

        // Build date filter based on selected time range
        let dateFilter = '';
        if (filter === '24-hours') dateFilter = "WHERE c.created_at >= NOW() - INTERVAL '24 hours'";
        if (filter === '7-days')   dateFilter = "WHERE c.created_at >= NOW() - INTERVAL '7 days'";
        if (filter === '30-days')  dateFilter = "WHERE c.created_at >= NOW() - INTERVAL '30 days'";

        const result = await pool.query(`
            SELECT
                COUNT(DISTINCT c.id)                                            AS total_customers,
                COUNT(CASE WHEN c.created_at >= CURRENT_DATE THEN 1 END)        AS customers_today,
                COUNT(DISTINCT t.id)                                            AS total_transactions,
                COALESCE(SUM(t.total_amount), 0)                                AS total_credit_given,
                COALESCE(SUM(COALESCE(ps.paid, 0)), 0)                          AS total_paid_amount,
                COALESCE(SUM(t.total_amount - COALESCE(ps.paid, 0)), 0)         AS total_pending_amount
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
            LEFT JOIN ${PAID_PER_TRANSACTION} ON ps.transaction_id = t.id
            ${dateFilter}
        `);

        const row = result.rows[0];

        res.json({
            success: true,
            statistics: {
                totalCustomers:     parseInt(row.total_customers)     || 0,
                customersToday:     parseInt(row.customers_today)     || 0,
                totalTransactions:  parseInt(row.total_transactions)  || 0,
                totalCreditGiven:   parseFloat(row.total_credit_given)  || 0,
                totalPaidAmount:    parseFloat(row.total_paid_amount)   || 0,
                totalPendingAmount: parseFloat(row.total_pending_amount)|| 0
            },
            filter
        });

    } catch (err) {
        console.error('Error fetching statistics:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

module.exports = router;
