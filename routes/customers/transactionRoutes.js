const express = require('express');
const path = require('path');
const pool = require('../../dbconnect');
const { requireAuth } = require('../auth');

const router = express.Router();

// -------------------------------------------------------------------
// SQL helper: sums payments per transaction to get amount paid so far
// -------------------------------------------------------------------
const PAID_PER_TRANSACTION = `(
    SELECT transaction_id, SUM(amount) AS paid
    FROM payment_logs
    GROUP BY transaction_id
) ps`;

// -------------------------------------------------------------------
// Helper: SQL to get transactions with paid and remaining amounts
// computed by joining with payment_logs
// -------------------------------------------------------------------
const TRANSACTIONS_QUERY = `
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
`;

// -------------------------------------------------------------------
// GET /customers/:id
// Shows the transactions page for a specific customer
// -------------------------------------------------------------------
router.get('/:id', requireAuth, async (req, res) => {
    try {
        const customerId = parseInt(req.params.id);

        // Get the customer's basic info
        const customerResult = await pool.query(
            'SELECT id, name, mobile_number FROM customers WHERE id = $1',
            [customerId]
        );

        if (customerResult.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const customer = customerResult.rows[0];

        // Get all transactions with paid/remaining amounts
        const txResult = await pool.query(TRANSACTIONS_QUERY, [customerId]);

        res.render('customer-transactions', {
            user: req.user,
            customer,
            transactions: txResult.rows
        });

    } catch (err) {
        console.error('Error loading customer transactions page:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// -------------------------------------------------------------------
// POST /customers/:id/transaction
// Adds a new transaction for a customer.
// Also logs an initial payment if paid_amount > 0.
// -------------------------------------------------------------------
router.post('/:id/transaction', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const customerId = parseInt(req.params.id);
        const {
            transaction_type, product_service, total_amount,
            paid_amount, payment_date, next_payment_date, notes
        } = req.body;

        // Basic validation
        if (!transaction_type || !total_amount) {
            return res.status(400).json({ error: 'Transaction type and total amount are required' });
        }

        // Make sure the customer exists
        const customerCheck = await client.query(
            'SELECT id FROM customers WHERE id = $1',
            [customerId]
        );
        if (customerCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const totalAmt = parseFloat(total_amount);
        const paidNow  = parseFloat(paid_amount || 0);
        // If the full amount is already paid, mark as completed
        const status   = paidNow >= totalAmt ? 'completed' : 'active';

        // Insert the transaction
        const txResult = await client.query(`
            INSERT INTO customer_transactions
                (customer_id, transaction_type, product_service, total_amount,
                 payment_date, next_payment_date, notes, status, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
            RETURNING id, transaction_type, total_amount, created_at
        `, [
            customerId, transaction_type, product_service, totalAmt,
            payment_date, next_payment_date, notes, status
        ]);

        const transactionId = txResult.rows[0].id;

        // If any amount was paid upfront, log it in payment_logs
        if (paidNow > 0) {
            await client.query(`
                INSERT INTO payment_logs (transaction_id, amount, payment_date, notes, created_at)
                VALUES ($1, $2, $3, $4, NOW())
            `, [transactionId, paidNow, payment_date, 'Initial payment']);
        }

        await client.query('COMMIT');
        res.status(201).json({
            success: true,
            transaction: txResult.rows[0],
            message: 'Transaction added successfully'
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error adding transaction:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// -------------------------------------------------------------------
// GET /customers/:id/transactions
// Returns all transactions for a customer as JSON (API endpoint)
// Includes paid_amount and remaining_amount per transaction
// -------------------------------------------------------------------
router.get('/:id/transactions', requireAuth, async (req, res) => {
    try {
        const customerId = parseInt(req.params.id);

        // Make sure the customer exists
        const customerCheck = await pool.query(
            'SELECT id FROM customers WHERE id = $1',
            [customerId]
        );
        if (customerCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        // Get transactions with paid/remaining calculated from payment_logs
        const result = await pool.query(TRANSACTIONS_QUERY, [customerId]);

        res.json({ success: true, transactions: result.rows });

    } catch (err) {
        console.error('Error fetching transactions:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// -------------------------------------------------------------------
// PUT /customers/:customerId/transaction/:transactionId
// Updates the details of an existing transaction
// (type, product, amount, dates, notes, status)
// -------------------------------------------------------------------
router.put('/:customerId/transaction/:transactionId', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        const customerId    = parseInt(req.params.customerId);
        const transactionId = parseInt(req.params.transactionId);

        const {
            transaction_type, product_service, total_amount,
            payment_date, next_payment_date, notes, status
        } = req.body;

        // Make sure the customer exists
        const customerCheck = await pool.query(
            'SELECT id FROM customers WHERE id = $1',
            [customerId]
        );
        if (customerCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        // Update the transaction record
        const result = await client.query(`
            UPDATE customer_transactions
            SET transaction_type  = $1,
                product_service   = $2,
                total_amount      = $3,
                payment_date      = $4,
                next_payment_date = $5,
                notes             = $6,
                status            = $7,
                updated_at        = NOW()
            WHERE id = $8 AND customer_id = $9
            RETURNING id, transaction_type, total_amount, updated_at
        `, [
            transaction_type, product_service, parseFloat(total_amount),
            payment_date, next_payment_date, notes, status,
            transactionId, customerId
        ]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Transaction not found' });
        }

        res.json({
            success: true,
            transaction: result.rows[0],
            message: 'Transaction updated successfully'
        });

    } catch (err) {
        console.error('Error updating transaction:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// -------------------------------------------------------------------
// POST /customers/add-payment
// Adds a new payment to an existing transaction.
// Recalculates remaining amount and updates transaction status.
// -------------------------------------------------------------------
router.post('/add-payment', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { transaction_id, customer_id, payment_amount, payment_date, notes } = req.body;

        // Validate required fields
        if (!transaction_id || !payment_amount) {
            return res.status(400).json({ error: 'transaction_id and payment_amount are required' });
        }

        // Get the transaction and how much has been paid so far
        const txResult = await client.query(`
            SELECT t.id, t.total_amount,
                   COALESCE(SUM(p.amount), 0) AS already_paid
            FROM customer_transactions t
            LEFT JOIN payment_logs p ON p.transaction_id = t.id
            WHERE t.id = $1 AND t.customer_id = $2
            GROUP BY t.id
        `, [transaction_id, customer_id]);

        if (txResult.rows.length === 0) {
            return res.status(404).json({ error: 'Transaction not found' });
        }

        const tx           = txResult.rows[0];
        const newPaid      = parseFloat(tx.already_paid) + parseFloat(payment_amount);
        const newRemaining = parseFloat(tx.total_amount) - newPaid;
        // If nothing is left to pay, mark the transaction as completed
        const newStatus    = newRemaining <= 0 ? 'completed' : 'active';

        // Log the new payment
        await client.query(`
            INSERT INTO payment_logs (transaction_id, amount, payment_date, notes, created_at)
            VALUES ($1, $2, $3, $4, NOW())
        `, [transaction_id, parseFloat(payment_amount), payment_date, notes]);

        // Update the transaction's status
        await client.query(`
            UPDATE customer_transactions SET status = $1, updated_at = NOW() WHERE id = $2
        `, [newStatus, transaction_id]);

        await client.query('COMMIT');
        res.json({
            success: true,
            message: 'Payment added successfully',
            newRemainingAmount: newRemaining,
            newStatus
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error adding payment:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// -------------------------------------------------------------------
// DELETE /customers/:customerId/transaction/:transactionId
// Deletes a transaction and all its payment records
// -------------------------------------------------------------------
router.delete('/:customerId/transaction/:transactionId', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const customerId    = parseInt(req.params.customerId);
        const transactionId = parseInt(req.params.transactionId);

        // Make sure the customer exists
        const customerCheck = await client.query(
            'SELECT id FROM customers WHERE id = $1',
            [customerId]
        );
        if (customerCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Customer not found' });
        }

        // Delete the payment history for this transaction first
        await client.query(
            'DELETE FROM payment_logs WHERE transaction_id = $1',
            [transactionId]
        );

        // Delete the transaction itself
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

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error deleting transaction:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// -------------------------------------------------------------------
// GET /customers/:customerId/transaction/:transactionId/payments
// Returns all payment records for a specific transaction
// -------------------------------------------------------------------
router.get('/:customerId/transaction/:transactionId/payments', requireAuth, async (req, res) => {
    try {
        const customerId    = parseInt(req.params.customerId);
        const transactionId = parseInt(req.params.transactionId);

        // Make sure the customer exists
        const customerCheck = await pool.query(
            'SELECT id FROM customers WHERE id = $1',
            [customerId]
        );
        if (customerCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        // Get all payments for this transaction, newest first
        const result = await pool.query(`
            SELECT id, amount AS payment_amount, payment_date, notes, created_at
            FROM payment_logs
            WHERE transaction_id = $1
            ORDER BY created_at DESC
        `, [transactionId]);

        res.json({ success: true, payments: result.rows });

    } catch (err) {
        console.error('Error fetching payment history:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
