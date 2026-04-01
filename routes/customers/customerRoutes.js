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
            SELECT 
                c.id, c.name, c.mobile_number, c.village_city, c.district, c.state,
                c.created_at,
                COUNT(t.id) as transaction_count,
                COALESCE(SUM(t.total_amount), 0) as total_amount,
                COALESCE(SUM(t.remaining_amount), 0) as pending_amount
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
            GROUP BY c.id, c.name, c.mobile_number, c.village_city, c.district, c.state, c.created_at
            ORDER BY c.created_at DESC
            LIMIT $1 OFFSET $2
        `;

        const countQuery = `
            SELECT COUNT(*) as total
            FROM customers
        `;

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

        // Validation
        if (!name || !mobile_number || !village_city || !district || !state) {
            return res.status(400).json({ error: 'Required fields are missing' });
        }

        if (!validateMobile(mobile_number)) {
            return res.status(400).json({ error: 'Invalid mobile number' });
        }

        // Check for duplicate mobile number
        const existingCustomer = await client.query(
            'SELECT id FROM customers WHERE mobile_number = $1',
            [mobile_number]
        );

        if (existingCustomer.rows.length > 0) {
            return res.status(400).json({ error: 'Mobile number already exists' });
        }

        // Insert customer
        const customerResult = await client.query(
            `INSERT INTO customers (name, mobile_number, village_city, district, state, complete_address, pincode, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
             RETURNING id, name, mobile_number, created_at`,
            [sanitizeInput(name), mobile_number, sanitizeInput(village_city), sanitizeInput(district),
             sanitizeInput(state), sanitizeInput(complete_address), pincode]
        );

        const customer = customerResult.rows[0];

        // Insert transaction if provided
        if (transaction_type && total_amount) {
            const remainingAmount = parseFloat(total_amount) - parseFloat(paid_amount || 0);
            const paidNow = parseFloat(paid_amount || 0);

            const transactionResult = await client.query(
                `INSERT INTO customer_transactions 
                 (customer_id, transaction_type, product_service, total_amount, paid_amount, remaining_amount, payment_date, next_payment_date, notes, status, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', NOW())
                 RETURNING id`,
                [customer.id, transaction_type, product_service, parseFloat(total_amount),
                 paidNow, remainingAmount, payment_date, next_payment_date, notes]
            );

            const transactionId = transactionResult.rows[0].id;

            // If there's an initial payment, record it in payment_logs
            if (paidNow > 0) {
                await client.query(
                    `INSERT INTO payment_logs 
                     (transaction_id, customer_id, amount, payment_date, notes, created_at)
                     VALUES ($1, $2, $3, $4, $5, NOW())`,
                    [transactionId, customer.id, paidNow, payment_date, 'Initial payment']
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

// UPDATE customer profile - DISABLED (customers cannot be edited, only transactions/payments)
// router.put('/:id', requireAuth, async (req, res) => {
//     ... customer update code removed for simplicity
// });

// DELETE - Delete customer and all their transactions
router.delete('/:id', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        const customerId = parseInt(req.params.id);

        // Check if customer exists
        const customerCheck = await client.query(
            'SELECT id FROM customers WHERE id = $1',
            [customerId]
        );

        if (customerCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        await client.query('BEGIN');

        // Delete customer (hard delete)
        await client.query(
            'DELETE FROM customers WHERE id = $1',
            [customerId]
        );

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

        const query = `
            SELECT id, name, mobile_number, village_city, district, state, complete_address, pincode, created_at
            FROM customers 
            WHERE id = $1
        `;

        const result = await pool.query(query, [customerId]);

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

        // Get customer details
        const customerCheck = await pool.query(
            `SELECT id, name, mobile_number, pincode, village_city, district, state, 
                    complete_address, created_at, updated_at 
             FROM customers 
             WHERE id = $1`,
            [customerId]
        );

        if (customerCheck.rows.length === 0) {
            return res.status(404).sendFile(path.join(__dirname, '../../public/404.html'));
        }

        const customer = customerCheck.rows[0];

        // Get all transactions for this customer
        const transactionsQuery = `
            SELECT 
                id, transaction_type, product_service, total_amount, paid_amount, remaining_amount,
                payment_date, next_payment_date, notes, status, created_at
            FROM customer_transactions 
            WHERE customer_id = $1 
            ORDER BY created_at DESC
        `;

        const transactionsResult = await pool.query(transactionsQuery, [customerId]);

        // Calculate summary statistics
        const stats = {
            total_amount: transactionsResult.rows.reduce((sum, t) => sum + parseFloat(t.total_amount || 0), 0),
            total_paid: transactionsResult.rows.reduce((sum, t) => sum + parseFloat(t.paid_amount || 0), 0),
            total_pending: transactionsResult.rows.reduce((sum, t) => sum + parseFloat(t.remaining_amount || 0), 0),
            completed_transactions: transactionsResult.rows.filter(t => t.status === 'completed').length,
            active_transactions: transactionsResult.rows.filter(t => t.status === 'active').length
        };

        res.render('customer-report', {
            user: req.user,
            customer: customer,
            transactions: transactionsResult.rows,
            stats: stats
        });

    } catch (error) {
        console.error('Error generating customer report:', error);
        res.status(500).sendFile(path.join(__dirname, '../../public/404.html'));
    }
});

module.exports = router;
