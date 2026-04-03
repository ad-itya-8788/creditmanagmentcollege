const express = require('express');
const path = require('path');
const pool = require('../../dbconnect');
const { requireAuth } = require('../auth');
const { sanitizeInput, validateMobile } = require('./customerUtils');

const router = express.Router();

// -------------------------------------------------------------------
// SQL helper: sums payments per transaction to get amount paid so far
// Used with LEFT JOIN so transactions with no payments show paid = 0
// -------------------------------------------------------------------
const PAID_PER_TRANSACTION = `(
    SELECT transaction_id, SUM(amount) AS paid
    FROM payment_logs
    GROUP BY transaction_id
) ps`;

// -------------------------------------------------------------------
// GET /customers
// Serves the main customers HTML page
// -------------------------------------------------------------------
router.get('/', requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, '../../views/customers.ejs'));
});

// -------------------------------------------------------------------
// GET /customers/adcm
// Serves the "Add Customer" HTML page
// -------------------------------------------------------------------
router.get('/adcm', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, '../../protected/addcustomer.html'));
});

// -------------------------------------------------------------------
// GET /customers/all
// Shows all customers with their total credit, paid, and pending amounts
// Supports pagination (10 customers per page)
// -------------------------------------------------------------------
router.get('/all', requireAuth, async (req, res) => {
    try {
        const page  = parseInt(req.query.page) || 1;
        const limit = 10;
        const skip  = (page - 1) * limit;

        // Get customers with their transaction summary
        const customers = await pool.query(`
            WITH tx_summary AS (
                SELECT
                    t.customer_id,
                    COUNT(t.id)                                             AS transaction_count,
                    COALESCE(SUM(t.total_amount), 0)                        AS total_amount,
                    COALESCE(SUM(COALESCE(ps.paid, 0)), 0)                  AS paid_amount,
                    COALESCE(SUM(t.total_amount - COALESCE(ps.paid, 0)), 0) AS pending_amount
                FROM customer_transactions t
                LEFT JOIN ${PAID_PER_TRANSACTION} ON ps.transaction_id = t.id
                GROUP BY t.customer_id
            )
            SELECT
                c.id, c.name, c.mobile_number, c.village_city,
                c.district, c.state, c.created_at,
                COALESCE(ts.transaction_count, 0) AS transaction_count,
                COALESCE(ts.total_amount, 0)      AS total_amount,
                COALESCE(ts.pending_amount, 0)    AS pending_amount
            FROM customers c
            LEFT JOIN tx_summary ts ON ts.customer_id = c.id
            ORDER BY c.created_at DESC
            LIMIT $1 OFFSET $2
        `, [limit, skip]);

        // Get total count for pagination
        const countResult   = await pool.query('SELECT COUNT(*) AS total FROM customers');
        const totalCustomers = parseInt(countResult.rows[0].total);
        const totalPages     = Math.ceil(totalCustomers / limit);

        res.render('all-customers', {
            user:            req.user,
            customers:       customers.rows,
            currentPage:     page,
            totalPages:      totalPages,
            totalCustomers:  totalCustomers
        });

    } catch (err) {
        console.error('Error loading all customers:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// -------------------------------------------------------------------
// POST /customers/add
// Adds a new customer.
// Optionally also creates their first transaction and initial payment.
// -------------------------------------------------------------------
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

// -------------------------------------------------------------------
// DELETE /customers/:id
// Deletes a customer and all their transactions (cascade)
// -------------------------------------------------------------------
router.delete('/:id', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        const customerId = parseInt(req.params.id);

        // Check if customer exists
        const check = await client.query(
            'SELECT id FROM customers WHERE id = $1',
            [customerId]
        );
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        await client.query('BEGIN');
        await client.query('DELETE FROM customers WHERE id = $1', [customerId]);
        await client.query('COMMIT');

        res.json({ success: true, message: 'Customer deleted successfully' });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error deleting customer:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// -------------------------------------------------------------------
// GET /customers/search/:value
// Search customers by name or phone number
// -------------------------------------------------------------------
router.get('/search/:value', requireAuth, async (req, res) => {
    try {
        const search = sanitizeInput(req.params.value);

        const result = await pool.query(`
            SELECT id, name, mobile_number, village_city, district, state, created_at
            FROM customers
            WHERE name ILIKE $1 OR mobile_number ILIKE $1
            ORDER BY name
            LIMIT 20
        `, [`%${search}%`]);

        res.json({ success: true, customers: result.rows });

    } catch (err) {
        console.error('Error searching customers:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// -------------------------------------------------------------------
// GET /customers/details/:id
// Returns basic customer info as JSON (used by frontend JS)
// -------------------------------------------------------------------
router.get('/details/:id', requireAuth, async (req, res) => {
    try {
        const customerId = parseInt(req.params.id);

        const result = await pool.query(`
            SELECT id, name, mobile_number, village_city, district, state,
                   complete_address, pincode, created_at
            FROM customers WHERE id = $1
        `, [customerId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        res.json({ success: true, customer: result.rows[0] });

    } catch (err) {
        console.error('Error fetching customer details:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// -------------------------------------------------------------------
// GET /customers/report/:id
// Renders the customer report page with all their transactions
// and totals for paid, remaining, and overall credit
// -------------------------------------------------------------------
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
