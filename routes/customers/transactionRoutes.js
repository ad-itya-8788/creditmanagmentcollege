const express = require('express');
const path = require('path');
const pool = require('../../dbconnect');
const { requireAuth } = require('../auth');
const { sanitizeInput } = require('./customerUtils');

const router = express.Router();

// GET customer transactions view
router.get('/:id', requireAuth, async (req, res) => {
    try {
        const customerId = parseInt(req.params.id);

        const customerCheck = await pool.query(
            'SELECT id, name, mobile_number FROM customers WHERE id = $1',
            [customerId]
        );

        if (customerCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const customer = customerCheck.rows[0];

        const transactionsResult = await pool.query(
            `SELECT
                t.id, t.transaction_type, t.product_service, t.total_amount,
                t.payment_date, t.next_payment_date, t.notes, t.status, t.created_at,
                COALESCE(SUM(p.amount), 0) AS paid_amount,
                t.total_amount - COALESCE(SUM(p.amount), 0) AS remaining_amount
             FROM customer_transactions t
             LEFT JOIN payment_logs p ON p.transaction_id = t.id
             WHERE t.customer_id = $1
             GROUP BY t.id
             ORDER BY t.created_at DESC`,
            [customerId]
        );

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

        if (!transaction_type || !total_amount) {
            return res.status(400).json({ error: 'Transaction type and total amount are required' });
        }

        const customerCheck = await client.query(
            'SELECT id FROM customers WHERE id = $1',
            [customerId]
        );

        if (customerCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const paidNow = parseFloat(paid_amount || 0);
        const totalAmt = parseFloat(total_amount);
        const initialStatus = paidNow >= totalAmt ? 'completed' : 'active';

        const result = await client.query(
            `INSERT INTO customer_transactions
             (customer_id, transaction_type, product_service, total_amount,
              payment_date, next_payment_date, notes, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
             RETURNING id, transaction_type, total_amount, created_at`,
            [customerId, transaction_type, product_service, totalAmt,
             payment_date, next_payment_date, notes, initialStatus]
        );

        const transactionId = result.rows[0].id;

        if (paidNow > 0) {
            await client.query(
                `INSERT INTO payment_logs (transaction_id, amount, payment_date, notes, created_at)
                 VALUES ($1, $2, $3, $4, NOW())`,
                [transactionId, paidNow, payment_date, 'Initial payment']
            );
        }

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

// Get transactions for customer (API)
router.get('/:id/transactions', requireAuth, async (req, res) => {
    try {
        const customerId = parseInt(req.params.id);

        const customerCheck = await pool.query(
            'SELECT id FROM customers WHERE id = $1',
            [customerId]
        );

        if (customerCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const result = await pool.query(
            `SELECT
                t.id, t.transaction_type, t.product_service, t.total_amount,
                t.payment_date, t.next_payment_date, t.notes, t.status, t.created_at,
                COALESCE(SUM(p.amount), 0) AS paid_amount,
                t.total_amount - COALESCE(SUM(p.amount), 0) AS remaining_amount
             FROM customer_transactions t
             LEFT JOIN payment_logs p ON p.transaction_id = t.id
             WHERE t.customer_id = $1
             GROUP BY t.id
             ORDER BY t.created_at DESC`,
            [customerId]
        );

        res.json({ success: true, transactions: result.rows });

    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update transaction metadata (type, product, dates, notes)
router.put('/:customerId/transaction/:transactionId', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        const customerId = parseInt(req.params.customerId);
        const transactionId = parseInt(req.params.transactionId);

        const {
            transaction_type,
            product_service,
            total_amount,
            payment_date,
            next_payment_date,
            notes,
            status
        } = req.body;

        const customerCheck = await pool.query(
            'SELECT id FROM customers WHERE id = $1',
            [customerId]
        );

        if (customerCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const result = await client.query(
            `UPDATE customer_transactions
             SET transaction_type = $1, product_service = $2, total_amount = $3,
                 payment_date = $4, next_payment_date = $5, notes = $6, status = $7,
                 updated_at = NOW()
             WHERE id = $8 AND customer_id = $9
             RETURNING id, transaction_type, total_amount, updated_at`,
            [transaction_type, product_service, parseFloat(total_amount),
             payment_date, next_payment_date, notes, status, transactionId, customerId]
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
        const { transaction_id, customer_id, payment_amount, payment_date, notes, rating } = req.body;

        if (!transaction_id || !payment_amount) {
            return res.status(400).json({ error: 'transaction_id and payment_amount are required' });
        }

        // Verify the transaction exists and belongs to the customer
        const transactionQuery = await client.query(
            `SELECT t.id, t.total_amount,
                    COALESCE(SUM(p.amount), 0) AS already_paid
             FROM customer_transactions t
             LEFT JOIN payment_logs p ON p.transaction_id = t.id
             WHERE t.id = $1 AND t.customer_id = $2
             GROUP BY t.id`,
            [transaction_id, customer_id]
        );

        if (transactionQuery.rows.length === 0) {
            return res.status(404).json({ error: 'Transaction not found' });
        }

        const tx = transactionQuery.rows[0];
        const newPaid = parseFloat(tx.already_paid) + parseFloat(payment_amount);
        const newRemaining = parseFloat(tx.total_amount) - newPaid;
        const newStatus = newRemaining <= 0 ? 'completed' : 'active';

        // Insert payment log
        await client.query(
            `INSERT INTO payment_logs (transaction_id, amount, payment_date, notes, created_at)
             VALUES ($1, $2, $3, $4, NOW())`,
            [transaction_id, parseFloat(payment_amount), payment_date, notes]
        );

        // Update status on the transaction
        await client.query(
            `UPDATE customer_transactions SET status = $1, updated_at = NOW() WHERE id = $2`,
            [newStatus, transaction_id]
        );

        await client.query('COMMIT');
        res.json({
            success: true,
            message: 'Payment added successfully',
            newRemainingAmount: newRemaining,
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

        const customerId = parseInt(req.params.customerId);
        const transactionId = parseInt(req.params.transactionId);

        const customerCheck = await client.query(
            'SELECT id FROM customers WHERE id = $1',
            [customerId]
        );

        if (customerCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Customer not found' });
        }

        // payment_logs cascade-deletes via FK, but we delete explicitly for safety
        await client.query('DELETE FROM payment_logs WHERE transaction_id = $1', [transactionId]);

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

// Get payment history for a specific transaction
router.get('/:customerId/transaction/:transactionId/payments', requireAuth, async (req, res) => {
    try {
        const customerId = parseInt(req.params.customerId);
        const transactionId = parseInt(req.params.transactionId);

        const customerCheck = await pool.query(
            'SELECT id FROM customers WHERE id = $1',
            [customerId]
        );

        if (customerCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const result = await pool.query(
            `SELECT id, amount AS payment_amount, payment_date, notes, created_at
             FROM payment_logs
             WHERE transaction_id = $1
             ORDER BY created_at DESC`,
            [transactionId]
        );

        res.json({ success: true, payments: result.rows });

    } catch (error) {
        console.error('Error fetching payment history:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
