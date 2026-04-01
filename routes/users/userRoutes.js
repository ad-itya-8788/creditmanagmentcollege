const express = require('express');
const path = require('path');
const pool = require('../../dbconnect');
const { requireAuth } = require('../auth');

const router = express.Router();

// GET /api/users/dashboard-stats - Get dashboard statistics for logged-in user
router.get('/dashboard-stats', requireAuth, async (req, res) => {
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
                COALESCE(SUM(CASE WHEN t.status = 'active' THEN t.remaining_amount ELSE 0 END), 0) as total_pending_amount,
                
                -- Performance Metrics
                CASE 
                    WHEN COALESCE(SUM(t.total_amount), 0) > 0 
                    THEN ROUND((COALESCE(SUM(t.paid_amount), 0)::DECIMAL / COALESCE(SUM(t.total_amount), 0)::DECIMAL) * 100, 1)
                    ELSE 0 
                END as success_rate,
                
                CASE 
                    WHEN COUNT(t.id) > 0 
                    THEN ROUND((COUNT(CASE WHEN t.status = 'completed' THEN 1 END)::DECIMAL / COUNT(t.id)::DECIMAL) * 100, 1)
                    ELSE 0 
                END as completion_rate,
                
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
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// GET /api/users/profile-stats - Get user profile statistics
router.get('/profile-stats', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user_id;

        // Get user basic info
        const userQuery = `
            SELECT user_id, shop_name, owner_name, email, owner_phone, shop_address, 
                   created_at, updated_at
            FROM users 
            WHERE user_id = $1
        `;

        // Get customer and transaction counts
        const countsQuery = `
            SELECT 
                COUNT(DISTINCT c.id) as total_customers,
                COUNT(t.id) as total_transactions,
                COUNT(CASE WHEN c.created_at >= CURRENT_DATE THEN 1 END) as customers_today
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
        `;

        const [userResult, countsResult] = await Promise.all([
            pool.query(userQuery, [userId]),
            pool.query(countsQuery)
        ]);

        if (userResult.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'User not found' 
            });
        }

        const user = userResult.rows[0];
        const counts = countsResult.rows[0];

        res.json({
            success: true,
            user: {
                user_id: user.user_id,
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
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// GET /api/users/activity - Get recent activity
router.get('/activity', requireAuth, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;

        // Get recent transactions
        const transactionsQuery = `
            SELECT 
                t.id,
                t.transaction_type,
                t.total_amount,
                t.paid_amount,
                t.remaining_amount,
                t.status,
                t.created_at,
                c.name as customer_name,
                c.mobile_number as customer_phone
            FROM customer_transactions t
            JOIN customers c ON t.customer_id = c.id
            ORDER BY t.created_at DESC
            LIMIT $1
        `;

        // Get recent customers
        const customersQuery = `
            SELECT 
                id, name, mobile_number, village_city, created_at,
                COUNT(t.id) as transaction_count
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
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// GET /api/users/summary - Get user summary
router.get('/summary', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user_id;

        // Get user info
        const userQuery = `
            SELECT user_id, shop_name, owner_name, email, created_at
            FROM users 
            WHERE user_id = $1
        `;

        // Get summary statistics
        const summaryQuery = `
            SELECT 
                COUNT(DISTINCT c.id) as total_customers,
                COUNT(t.id) as total_transactions,
                COALESCE(SUM(t.total_amount), 0) as total_credit,
                COALESCE(SUM(t.paid_amount), 0) as total_paid,
                COALESCE(SUM(t.remaining_amount), 0) as total_pending,
                COUNT(CASE WHEN t.status = 'completed' THEN 1 END) as completed_transactions,
                COUNT(CASE WHEN t.status = 'active' THEN 1 END) as active_transactions
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
        `;

        const [userResult, summaryResult] = await Promise.all([
            pool.query(userQuery, [userId]),
            pool.query(summaryQuery)
        ]);

        if (userResult.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'User not found' 
            });
        }

        const user = userResult.rows[0];
        const summary = summaryResult.rows[0];

        res.json({
            success: true,
            user: {
                user_id: user.user_id,
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
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

module.exports = router;
