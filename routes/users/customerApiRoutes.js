const express = require('express');
const pool = require('../../dbconnect');
const { requireAuth } = require('../auth');

const router = express.Router();

// GET /api/users/recent-customers - Get recent customers for search/display
router.get('/recent-customers', requireAuth, async (req, res) => {
    try {
        const { limit = 5 } = req.query;

        const query = `
            SELECT 
                c.id,
                c.name,
                c.mobile_number,
                c.village_city,
                c.district,
                c.created_at,
                COUNT(t.id) as transaction_count,
                COALESCE(SUM(t.total_amount), 0) as total_amount,
                COALESCE(SUM(t.remaining_amount), 0) as pending_amount
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
            GROUP BY c.id, c.name, c.mobile_number, c.village_city, c.district, c.created_at
            ORDER BY c.created_at DESC
            LIMIT $1
        `;

        const result = await pool.query(query, [limit]);
        
        res.json({
            success: true,
            customers: result.rows
        });

    } catch (error) {
        console.error('Error fetching recent customers:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// GET /api/users/search-customers - Search customers by name or phone
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

        const finalQuery = `
            SELECT 
                c.id,
                c.name,
                c.mobile_number,
                c.village_city,
                c.district,
                c.state,
                c.created_at,
                COUNT(t.id) as transaction_count,
                COALESCE(SUM(t.total_amount), 0) as total_amount,
                COALESCE(SUM(t.remaining_amount), 0) as pending_amount,
                CASE 
                    WHEN COALESCE(SUM(t.remaining_amount), 0) = 0 AND COUNT(t.id) > 0 THEN true 
                    ELSE false 
                END as is_clear
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
            ${whereClause}
            GROUP BY c.id, c.name, c.mobile_number, c.village_city, c.district, c.state, c.created_at
            ORDER BY c.name
            LIMIT ${queryParams.length + 1}
        `;

        queryParams.push(limit);
        const result = await pool.query(finalQuery, queryParams);
        
        res.json({
            success: true,
            customers: result.rows,
            total: result.rows.length
        });

    } catch (error) {
        console.error('Error searching customers:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// GET /api/users/customer/:id - Get detailed customer information
router.get('/customer/:id', requireAuth, async (req, res) => {
    try {
        const customerId = parseInt(req.params.id);

        // Get customer details
        const customerQuery = `
            SELECT 
                id, name, mobile_number, village_city, district, state, 
                complete_address, pincode, created_at, updated_at
            FROM customers 
            WHERE id = $1
        `;

        // Get transaction summary
        const transactionQuery = `
            SELECT 
                COUNT(t.id) as transaction_count,
                COALESCE(SUM(t.total_amount), 0) as total_amount,
                COALESCE(SUM(t.paid_amount), 0) as paid_amount,
                COALESCE(SUM(t.remaining_amount), 0) as pending_amount,
                COUNT(CASE WHEN t.status = 'completed' THEN 1 END) as completed_transactions,
                COUNT(CASE WHEN t.status = 'active' THEN 1 END) as active_transactions,
                COUNT(CASE 
                    WHEN t.next_payment_date < CURRENT_DATE 
                    AND t.remaining_amount > 0 
                    AND t.status = 'active'
                    THEN 1 
                END) as overdue_transactions,
                MIN(t.payment_date) as first_payment_date,
                MAX(t.next_payment_date) as next_due_date
            FROM customer_transactions t
            WHERE t.customer_id = $1
        `;

        // Get recent transactions
        const recentTransactionsQuery = `
            SELECT 
                id, transaction_type, product_service, total_amount, paid_amount, 
                remaining_amount, payment_date, next_payment_date, notes, status, created_at
            FROM customer_transactions 
            WHERE customer_id = $1
            ORDER BY created_at DESC
            LIMIT 5
        `;

        const [customerResult, transactionResult, recentResult] = await Promise.all([
            pool.query(customerQuery, [customerId]),
            pool.query(transactionQuery, [customerId]),
            pool.query(recentTransactionsQuery, [customerId])
        ]);

        if (customerResult.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'Customer not found' 
            });
        }

        const customer = customerResult.rows[0];
        const transactionStats = transactionResult.rows[0] || {};

        res.json({
            success: true,
            customer: {
                ...customer,
                transactionCount: parseInt(transactionStats.transaction_count) || 0,
                totalAmount: parseFloat(transactionStats.total_amount) || 0,
                paidAmount: parseFloat(transactionStats.paid_amount) || 0,
                pendingAmount: parseFloat(transactionStats.pending_amount) || 0,
                completedTransactions: parseInt(transactionStats.completed_transactions) || 0,
                activeTransactions: parseInt(transactionStats.active_transactions) || 0,
                overdueTransactions: parseInt(transactionStats.overdue_transactions) || 0,
                firstPaymentDate: transactionStats.first_payment_date,
                nextDueDate: transactionStats.next_due_date,
                hasOverdue: parseInt(transactionStats.overdue_transactions) > 0,
                isClear: (parseFloat(transactionStats.pending_amount) || 0) === 0 && (parseInt(transactionStats.transaction_count) || 0) > 0
            },
            recentTransactions: recentResult.rows
        });

    } catch (error) {
        console.error('Error fetching customer details:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// GET /api/users/customers/statistics - Get customers statistics
router.get('/customers/statistics', requireAuth, async (req, res) => {
    try {
        const { filter = 'all-time' } = req.query;

        let dateFilter = '';

        // Apply date filter
        switch (filter) {
            case '24-hours':
                dateFilter = 'c.created_at >= NOW() - INTERVAL \'24 hours\'';
                break;
            case '7-days':
                dateFilter = 'c.created_at >= NOW() - INTERVAL \'7 days\'';
                break;
            case '30-days':
                dateFilter = 'c.created_at >= NOW() - INTERVAL \'30 days\'';
                break;
            case 'all-time':
            default:
                dateFilter = '';
                break;
        }

        const query = `
            SELECT 
                COUNT(DISTINCT c.id) as total_customers,
                COUNT(CASE WHEN c.created_at >= CURRENT_DATE THEN 1 END) as customers_today,
                COUNT(t.id) as total_transactions,
                COALESCE(SUM(t.total_amount), 0) as total_credit_given,
                COALESCE(SUM(t.paid_amount), 0) as total_paid_amount,
                COALESCE(SUM(t.remaining_amount), 0) as total_pending_amount
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
            ${dateFilter ? 'WHERE ' + dateFilter.replace('AND ', '') : ''}
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
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

module.exports = router;
