const express = require('express');
const path = require('path');
const pool = require('../../dbconnect');
const { requireAuth } = require('../auth');
const { sanitizeInput, validateMobile } = require('./customerUtils');

const router = express.Router();

//helper fun group by t id total amount
const PAID_PER_TRANSACTION = `(
    SELECT transaction_id, SUM(amount) AS paid
    FROM payment_logs
    GROUP BY transaction_id
) ps`;

//main customer.ejs page
router.get('/', requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, '../../views/customers.ejs'));
});

//add customer page
router.get('/adcm', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, '../../protected/addcustomer.html'));
});

//addnew customer and his new transition
router.post('/add', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const {
            name, mobile_number, village_city, district, state,
            complete_address, pincode,
            transaction_type, product_service, total_amount,
            paid_amount, payment_date, next_payment_date, notes
        } = req.body;

        // Validate required fields
        if (!name || !mobile_number || !village_city || !district || !state) {
            return res.status(400).json({ error: 'Required fields are missing' });
        }

        if (!validateMobile(mobile_number)) {
            return res.status(400).json({ error: 'Invalid mobile number (must be 10 digits)' });
        }

        // Check if mobile number already exists
        const existing = await client.query(
            'SELECT id FROM customers WHERE mobile_number = $1',
            [mobile_number]
        );
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Mobile number already exists' });
        }

        // Insert the new customer
        const customerResult = await client.query(`
            INSERT INTO customers
                (name, mobile_number, village_city, district, state, complete_address, pincode, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            RETURNING id, name, mobile_number, created_at
        `, [
            sanitizeInput(name), mobile_number,
            sanitizeInput(village_city), sanitizeInput(district),
            sanitizeInput(state), sanitizeInput(complete_address), pincode
        ]);

        const customer = customerResult.rows[0];

        // If transaction details are provided, create the first transaction
        if (transaction_type && total_amount) {
            const totalAmt  = parseFloat(total_amount);
            const paidNow   = parseFloat(paid_amount || 0);
            // If the full amount is paid, mark it completed right away
            const status    = paidNow >= totalAmt ? 'completed' : 'active';

            const txResult = await client.query(`
                INSERT INTO customer_transactions
                    (customer_id, transaction_type, product_service, total_amount,
                     payment_date, next_payment_date, notes, status, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                RETURNING id
            `, [
                customer.id, transaction_type, product_service, totalAmt,
                payment_date, next_payment_date, notes, status
            ]);

            const transactionId = txResult.rows[0].id;

            // If any amount was paid upfront, log it
            if (paidNow > 0) {
                await client.query(`
                    INSERT INTO payment_logs (transaction_id, amount, payment_date, notes, created_at)
                    VALUES ($1, $2, $3, $4, NOW())
                `, [transactionId, paidNow, payment_date, 'Initial payment']);
            }
        }

        await client.query('COMMIT');
        res.status(201).json({ success: true, customer, message: 'Customer added successfully' });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error adding customer:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

//customer Report
router.get('/report/:id', requireAuth, async (req, res) => {
    try {
        const customerId = parseInt(req.params.id);

        // Get customer basic info
        const customerResult = await pool.query(`
            SELECT id, name, mobile_number, pincode, village_city, district,
                   state, complete_address, created_at, updated_at
            FROM customers WHERE id = $1
        `, [customerId]);

        if (customerResult.rows.length === 0) {
            return res.status(404).sendFile(path.join(__dirname, '../../public/404.html'));
        }

        const customer = customerResult.rows[0];

        // Get all transactions with paid and remaining calculated from payment_logs
        const txResult = await pool.query(`
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
        `, [customerId]);

        const transactions = txResult.rows;

        // Calculate summary totals from the transactions list
        const stats = {
            total_transactions:    transactions.length,
            total_amount:          transactions.reduce((sum, t) => sum + parseFloat(t.total_amount   || 0), 0),
            total_paid:            transactions.reduce((sum, t) => sum + parseFloat(t.paid_amount     || 0), 0),
            total_pending:         transactions.reduce((sum, t) => sum + parseFloat(t.remaining_amount|| 0), 0),
            completed_transactions:transactions.filter(t => t.status === 'completed').length,
            active_transactions:   transactions.filter(t => t.status === 'active').length
        };

        res.render('customer-report', { user: req.user, customer, transactions, stats });

    } catch (err) {
        console.error('Error generating customer report:', err);
        res.status(500).sendFile(path.join(__dirname, '../../public/404.html'));
    }
});

module.exports = router;
