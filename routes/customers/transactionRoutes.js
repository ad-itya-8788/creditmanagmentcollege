const express = require('express');
const path = require('path');
const pool = require('../../dbconnect');
const { requireAuth } = require('../auth');

const router = express.Router();
// SQL helper: sums payments per transaction to get amount paid so far
const PAID_PER_TRANSACTION = `(
    SELECT transaction_id, SUM(amount) AS paid
    FROM payment_logs
    GROUP BY transaction_id
) ps`;

// Helper: SQL to get transactions with paid and remaining amounts
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



router.post('/add-payment', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { transaction_id, customer_id, payment_amount, payment_date, notes } = req.body;

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

// Returns all payment records for a specific transaction customer transition all cards

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
