const express = require('express');
const path = require('path');
const pool = require('../../dbconnect');
const { requireAuth } = require('../auth');
const { sanitizeInput } = require('./customerUtils');

const router = express.Router();

// GET customer transactions (for transaction view)
router.get('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user_id;
        const customerId = parseInt(req.params.id);

        // Check if customer belongs to user
        const customerCheck = await pool.query(
            'SELECT id, name, mobile_number FROM customers WHERE id = $1 AND created_by = $2 AND is_active = true',
            [customerId, userId]
        );

        if (customerCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const customer = customerCheck.rows[0];

        // Get transactions
        const transactionsQuery = `
            SELECT id, transaction_type, product_service, total_amount, paid_amount, remaining_amount,
                   payment_date, next_payment_date, notes, status, created_at
            FROM customer_transactions 
            WHERE customer_id = $1 
            ORDER BY created_at DESC
        `;

        const transactionsResult = await pool.query(transactionsQuery, [customerId]);

        res.render('customer-transactions', {
            user: req.user,
            customer: customer,
            transactions: transactionsResult.rows
        });

    } catch (error) {
        console.error('Error fetching customer transactions:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Add transaction for customer
router.post('/:id/transaction', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userId = req.session.user_id;
        const customerId = parseInt(req.params.id);

        const {
            transaction_type,
            product_service,
            total_amount,
            paid_amount,
            payment_date,
            next_payment_date,
            notes
        } = req.body;

        // Validation
        if (!transaction_type || !total_amount) {
            return res.status(400).json({ error: 'Transaction type and total amount are required' });
        }

        // Check if customer belongs to user
        const customerCheck = await client.query(
            'SELECT id FROM customers WHERE id = $1 AND created_by = $2 AND is_active = true',
            [customerId, userId]
        );

        if (customerCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const remainingAmount = parseFloat(total_amount) - parseFloat(paid_amount || 0);

        const result = await client.query(
            `INSERT INTO customer_transactions 
             (customer_id, transaction_type, product_service, total_amount, paid_amount, remaining_amount, 
              payment_date, next_payment_date, notes, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', NOW())
             RETURNING id, transaction_type, total_amount, remaining_amount, created_at`,
            [customerId, transaction_type, product_service, parseFloat(total_amount),
             parseFloat(paid_amount || 0), remainingAmount, payment_date, next_payment_date, notes]
        );

        await client.query('COMMIT');
        res.status(201).json({
            success: true,
            transaction: result.rows[0],
            message: 'Transaction added successfully'
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error adding transaction:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// Get transactions for customer
router.get('/:id/transactions', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user_id;
        const customerId = parseInt(req.params.id);

        // Check if customer belongs to user
        const customerCheck = await pool.query(
            'SELECT id FROM customers WHERE id = $1 AND created_by = $2 AND is_active = true',
            [customerId, userId]
        );

        if (customerCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const query = `
            SELECT id, transaction_type, product_service, total_amount, paid_amount, remaining_amount,
                   payment_date, next_payment_date, notes, status, created_at
            FROM customer_transactions 
            WHERE customer_id = $1 
            ORDER BY created_at DESC
        `;

        const result = await pool.query(query, [customerId]);
        res.json({ success: true, transactions: result.rows });

    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update transaction
router.put('/:customerId/transaction/:transactionId', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        const userId = req.session.user_id;
        const customerId = parseInt(req.params.customerId);
        const transactionId = parseInt(req.params.transactionId);

        const {
            transaction_type,
            product_service,
            total_amount,
            paid_amount,
            payment_date,
            next_payment_date,
            notes,
            status
        } = req.body;

        // Check if customer belongs to user
        const customerCheck = await pool.query(
            'SELECT id FROM customers WHERE id = $1 AND created_by = $2 AND is_active = true',
            [customerId, userId]
        );

        if (customerCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const remainingAmount = parseFloat(total_amount) - parseFloat(paid_amount || 0);

        const result = await client.query(
            `UPDATE customer_transactions 
             SET transaction_type = $1, product_service = $2, total_amount = $3, paid_amount = $4, 
                 remaining_amount = $5, payment_date = $6, next_payment_date = $7, notes = $8, status = $9
             WHERE id = $10 AND customer_id = $11
             RETURNING id, transaction_type, total_amount, remaining_amount, updated_at`,
            [transaction_type, product_service, parseFloat(total_amount), parseFloat(paid_amount || 0),
             remainingAmount, payment_date, next_payment_date, notes, status, transactionId, customerId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Transaction not found' });
        }

        res.json({
            success: true,
            transaction: result.rows[0],
            message: 'Transaction updated successfully'
        });

    } catch (error) {
        console.error('Error updating transaction:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// Add payment to existing transaction
router.post('/add-payment', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userId = req.session.user_id;
        const { transaction_id, customer_id, payment_amount, payment_date, notes, rating } = req.body;

        // Validation
        if (!transaction_id || !customer_id || !payment_amount) {
            return res.status(400).json({ error: 'Required fields are missing' });
        }

        // Check if customer belongs to user
        const customerCheck = await client.query(
            'SELECT id FROM customers WHERE id = $1 AND created_by = $2 AND is_active = true',
            [customer_id, userId]
        );

        if (customerCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        // Get current transaction
        const transactionQuery = await client.query(
            'SELECT total_amount, paid_amount, remaining_amount FROM customer_transactions WHERE id = $1 AND customer_id = $2',
            [transaction_id, customer_id]
        );

        if (transactionQuery.rows.length === 0) {
            return res.status(404).json({ error: 'Transaction not found' });
        }

        const transaction = transactionQuery.rows[0];
        const newPaidAmount = parseFloat(transaction.paid_amount) + parseFloat(payment_amount);
        const newRemainingAmount = parseFloat(transaction.total_amount) - newPaidAmount;

        const newStatus = newRemainingAmount <= 0 ? 'completed' : 'active';

        // Update transaction
        await client.query(
            `UPDATE customer_transactions 
             SET paid_amount = $1, remaining_amount = $2, status = $3, updated_at = NOW()
             WHERE id = $4 AND customer_id = $5`,
            [newPaidAmount, newRemainingAmount, newStatus, transaction_id, customer_id]
        );

        // Add payment record
        await client.query(
            `INSERT INTO payment_logs 
             (transaction_id, customer_id, amount, payment_date, notes, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [transaction_id, customer_id, parseFloat(payment_amount), payment_date, notes]
        );

        await client.query('COMMIT');
        res.json({
            success: true,
            message: 'Payment added successfully',
            newRemainingAmount: newRemainingAmount,
            newStatus: newStatus
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error adding payment:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// Delete transaction
router.delete('/:customerId/transaction/:transactionId', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const userId = req.session.user_id;
        const customerId = parseInt(req.params.customerId);
        const transactionId = parseInt(req.params.transactionId);

        // Check if customer belongs to user
        const customerCheck = await client.query(
            'SELECT id FROM customers WHERE id = $1 AND created_by = $2 AND is_active = true',
            [customerId, userId]
        );

        if (customerCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Customer not found' });
        }

        // First delete related payment logs
        await client.query(
            'DELETE FROM payment_logs WHERE transaction_id = $1',
            [transactionId]
        );

        // Then delete the transaction
        const result = await client.query(
            'DELETE FROM customer_transactions WHERE id = $1 AND customer_id = $2 RETURNING id',
            [transactionId, customerId]
        );

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Transaction not found' });
        }

        await client.query('COMMIT');
        res.json({ success: true, message: 'Transaction deleted successfully' });

    } catch (error) {
        console.error('Error deleting transaction:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// Get payment history (logs) for a specific transaction
router.get('/:customerId/transaction/:transactionId/payments', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user_id;
        const customerId = parseInt(req.params.customerId);
        const transactionId = parseInt(req.params.transactionId);

        // Check if customer belongs to user
        const customerCheck = await pool.query(
            'SELECT id FROM customers WHERE id = $1 AND created_by = $2 AND is_active = true',
            [customerId, userId]
        );

        if (customerCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const query = `
            SELECT id, amount as payment_amount, payment_date, notes, created_at
            FROM payment_logs 
            WHERE transaction_id = $1 
            ORDER BY created_at DESC
        `;

        const result = await pool.query(query, [transactionId]);
        res.json({ success: true, payments: result.rows });

    } catch (error) {
        console.error('Error fetching payment history:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
