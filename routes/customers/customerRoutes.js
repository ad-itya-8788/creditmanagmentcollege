const express = require('express');
const path = require('path');
const pool = require('../../dbconnect');
const { requireAuth } = require('../auth');
const { sanitizeInput, validateMobile } = require('./customerUtils');

const router = express.Router();

// Serve main customers page
router.get('/', requireAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, '../../views/customers.ejs'));
});

// Serve add customer page
router.get('/adcm', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, '../../protected/addcustomer.html'));
});

// Display all customers with their transactions page
router.get('/all', requireAuth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 10;
        const offset = (page - 1) * limit;

        const customersQuery = `
            WITH tx_summary AS (
                SELECT
                    t.customer_id,
                    COUNT(t.id) AS transaction_count,
                    COALESCE(SUM(t.total_amount), 0) AS total_amount,
                    COALESCE(SUM(COALESCE(ps.paid, 0)), 0) AS paid_amount,
                    COALESCE(SUM(t.total_amount - COALESCE(ps.paid, 0)), 0) AS pending_amount
                FROM customer_transactions t
                LEFT JOIN (
                    SELECT transaction_id, SUM(amount) AS paid
                    FROM payment_logs
                    GROUP BY transaction_id
                ) ps ON ps.transaction_id = t.id
                GROUP BY t.customer_id
            )
            SELECT
                c.id, c.name, c.mobile_number, c.village_city, c.district, c.state, c.created_at,
                COALESCE(ts.transaction_count, 0) AS transaction_count,
                COALESCE(ts.total_amount, 0) AS total_amount,
                COALESCE(ts.pending_amount, 0) AS pending_amount
            FROM customers c
            LEFT JOIN tx_summary ts ON ts.customer_id = c.id
            ORDER BY c.created_at DESC
            LIMIT $1 OFFSET $2
        `;

        const countQuery = `SELECT COUNT(*) AS total FROM customers`;

        const [customersResult, countResult] = await Promise.all([
            pool.query(customersQuery, [limit, offset]),
            pool.query(countQuery)
        ]);

        const totalCustomers = parseInt(countResult.rows[0].total);
        const totalPages = Math.ceil(totalCustomers / limit);

        res.render('all-customers', {
            user: req.user,
            customers: customersResult.rows,
            currentPage: page,
            totalPages: totalPages,
            totalCustomers: totalCustomers
        });

    } catch (error) {
        console.error('Error fetching all customers:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// CREATE - Add new customer with transaction
router.post('/add', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const {
            name,
            mobile_number,
            village_city,
            district,
            state,
            complete_address,
            pincode,
            transaction_type,
            product_service,
            total_amount,
            paid_amount,
            payment_date,
            next_payment_date,
            notes
        } = req.body;

        if (!name || !mobile_number || !village_city || !district || !state) {
            return res.status(400).json({ error: 'Required fields are missing' });
        }

        if (!validateMobile(mobile_number)) {
            return res.status(400).json({ error: 'Invalid mobile number' });
        }

        const existingCustomer = await client.query(
            'SELECT id FROM customers WHERE mobile_number = $1',
            [mobile_number]
        );

        if (existingCustomer.rows.length > 0) {
            return res.status(400).json({ error: 'Mobile number already exists' });
        }

        const customerResult = await client.query(
            `INSERT INTO customers (name, mobile_number, village_city, district, state, complete_address, pincode, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
             RETURNING id, name, mobile_number, created_at`,
            [sanitizeInput(name), mobile_number, sanitizeInput(village_city), sanitizeInput(district),
             sanitizeInput(state), sanitizeInput(complete_address), pincode]
        );

        const customer = customerResult.rows[0];

        if (transaction_type && total_amount) {
            const paidNow = parseFloat(paid_amount || 0);
            const totalAmt = parseFloat(total_amount);
            const initialStatus = paidNow >= totalAmt ? 'completed' : 'active';

            const transactionResult = await client.query(
                `INSERT INTO customer_transactions
                 (customer_id, transaction_type, product_service, total_amount, payment_date, next_payment_date, notes, status, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                 RETURNING id`,
                [customer.id, transaction_type, product_service, totalAmt,
                 payment_date, next_payment_date, notes, initialStatus]
            );

            const transactionId = transactionResult.rows[0].id;

            if (paidNow > 0) {
                await client.query(
                    `INSERT INTO payment_logs (transaction_id, amount, payment_date, notes, created_at)
                     VALUES ($1, $2, $3, $4, NOW())`,
                    [transactionId, paidNow, payment_date, 'Initial payment']
                );
            }
        }

        await client.query('COMMIT');
        res.status(201).json({
            success: true,
            customer: customer,
            message: 'Customer added successfully'
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error adding customer:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// DELETE - Delete customer and all their transactions
router.delete('/:id', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        const customerId = parseInt(req.params.id);

        const customerCheck = await client.query(
            'SELECT id FROM customers WHERE id = $1',
            [customerId]
        );

        if (customerCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        await client.query('BEGIN');
        await client.query('DELETE FROM customers WHERE id = $1', [customerId]);
        await client.query('COMMIT');
        res.json({ success: true, message: 'Customer deleted successfully' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting customer:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// Search customers by name or phone
router.get('/search/:value', requireAuth, async (req, res) => {
    try {
        const searchValue = sanitizeInput(req.params.value);

        const query = `
            SELECT id, name, mobile_number, village_city, district, state, created_at
            FROM customers
            WHERE (name ILIKE $1 OR mobile_number ILIKE $2)
            ORDER BY name
            LIMIT 20
        `;

        const result = await pool.query(query, [`%${searchValue}%`, `%${searchValue}%`]);
        res.json({ success: true, customers: result.rows });

    } catch (error) {
        console.error('Error searching customers:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET customer details
router.get('/details/:id', requireAuth, async (req, res) => {
    try {
        const customerId = parseInt(req.params.id);

        const result = await pool.query(
            `SELECT id, name, mobile_number, village_city, district, state, complete_address, pincode, created_at
             FROM customers WHERE id = $1`,
            [customerId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        res.json({ success: true, customer: result.rows[0] });

    } catch (error) {
        console.error('Error fetching customer details:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET customer report page
router.get('/report/:id', requireAuth, async (req, res) => {
    try {
        const customerId = parseInt(req.params.id);

        const customerCheck = await pool.query(
            `SELECT id, name, mobile_number, pincode, village_city, district, state,
                    complete_address, created_at, updated_at
             FROM customers WHERE id = $1`,
            [customerId]
        );

        if (customerCheck.rows.length === 0) {
            return res.status(404).sendFile(path.join(__dirname, '../../public/404.html'));
        }

        const customer = customerCheck.rows[0];

        // Fetch transactions with paid/remaining computed from payment_logs
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

        const transactions = transactionsResult.rows;

        const totalAmount = transactions.reduce((s, t) => s + parseFloat(t.total_amount || 0), 0);
        const totalPaid   = transactions.reduce((s, t) => s + parseFloat(t.paid_amount || 0), 0);
        const totalPending = transactions.reduce((s, t) => s + parseFloat(t.remaining_amount || 0), 0);

        const stats = {
            total_amount: totalAmount,
            total_paid: totalPaid,
            total_pending: totalPending,
            total_transactions: transactions.length,
            completed_transactions: transactions.filter(t => t.status === 'completed').length,
            active_transactions: transactions.filter(t => t.status === 'active').length
        };

        res.render('customer-report', {
            user: req.user,
            customer: customer,
            transactions: transactions,
            stats: stats
        });

    } catch (error) {
        console.error('Error generating customer report:', error);
        res.status(500).sendFile(path.join(__dirname, '../../public/404.html'));
    }
});

module.exports = router;
