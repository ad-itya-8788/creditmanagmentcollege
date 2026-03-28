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
        const userId = req.session.user_id;
        const page = parseInt(req.query.page) || 1;
        const limit = 10;
        const offset = (page - 1) * limit;

        const customersQuery = `
            SELECT 
                c.id, c.name, c.mobile_number, c.village_city, c.district, c.state,
                c.created_at, c.is_active,
                COUNT(t.id) as transaction_count,
                COALESCE(SUM(t.total_amount), 0) as total_amount,
                COALESCE(SUM(t.remaining_amount), 0) as pending_amount
            FROM customers c
            LEFT JOIN customer_transactions t ON c.id = t.customer_id
            WHERE c.created_by = $1 AND c.is_active = true
            GROUP BY c.id, c.name, c.mobile_number, c.village_city, c.district, c.state, c.created_at, c.is_active
            ORDER BY c.created_at DESC
            LIMIT $2 OFFSET $3
        `;

        const countQuery = `
            SELECT COUNT(*) as total
            FROM customers 
            WHERE created_by = $1 AND is_active = true
        `;

        const [customersResult, countResult] = await Promise.all([
            pool.query(customersQuery, [userId, limit, offset]),
            pool.query(countQuery, [userId])
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
        const userId = req.session.user_id;

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
            'SELECT id FROM customers WHERE mobile_number = $1 AND created_by = $2 AND is_active = true',
            [mobile_number, userId]
        );

        if (existingCustomer.rows.length > 0) {
            return res.status(400).json({ error: 'Mobile number already exists' });
        }

        // Insert customer
        const customerResult = await client.query(
            `INSERT INTO customers (name, mobile_number, village_city, district, state, complete_address, pincode, created_by, created_at, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), true)
             RETURNING id, name, mobile_number, created_at`,
            [sanitizeInput(name), mobile_number, sanitizeInput(village_city), sanitizeInput(district),
             sanitizeInput(state), sanitizeInput(complete_address), pincode, userId]
        );

        const customer = customerResult.rows[0];

        // Insert transaction if provided
        if (transaction_type && total_amount) {
            const remainingAmount = parseFloat(total_amount) - parseFloat(paid_amount || 0);

            await client.query(
                `INSERT INTO customer_transactions 
                 (customer_id, transaction_type, product_service, total_amount, paid_amount, remaining_amount, payment_date, next_payment_date, notes, status, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', NOW())`,
                [customer.id, transaction_type, product_service, parseFloat(total_amount),
                 parseFloat(paid_amount || 0), remainingAmount, payment_date, next_payment_date, notes]
            );
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

// UPDATE customer profile
router.put('/:id', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        const userId = req.session.user_id;
        const customerId = parseInt(req.params.id);
        const {
            name,
            mobile_number,
            village_city,
            district,
            state,
            complete_address,
            pincode
        } = req.body;

        // Validation
        if (!name || !mobile_number || !village_city || !district || !state) {
            return res.status(400).json({ error: 'Required fields are missing' });
        }

        if (!validateMobile(mobile_number)) {
            return res.status(400).json({ error: 'Invalid mobile number' });
        }

        // Check if customer belongs to user
        const customerCheck = await client.query(
            'SELECT id FROM customers WHERE id = $1 AND created_by = $2 AND is_active = true',
            [customerId, userId]
        );

        if (customerCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        // Check for duplicate mobile number (excluding current customer)
        const duplicateCheck = await client.query(
            'SELECT id FROM customers WHERE mobile_number = $1 AND id != $2 AND created_by = $3 AND is_active = true',
            [mobile_number, customerId, userId]
        );

        if (duplicateCheck.rows.length > 0) {
            return res.status(400).json({ error: 'Mobile number already exists' });
        }

        // Update customer
        const result = await client.query(
            `UPDATE customers 
             SET name = $1, mobile_number = $2, village_city = $3, district = $4, state = $5, 
                 complete_address = $6, pincode = $7, updated_at = NOW()
             WHERE id = $8 AND created_by = $9 AND is_active = true
             RETURNING id, name, mobile_number, updated_at`,
            [sanitizeInput(name), mobile_number, sanitizeInput(village_city), sanitizeInput(district),
             sanitizeInput(state), sanitizeInput(complete_address), pincode, customerId, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        res.json({
            success: true,
            customer: result.rows[0],
            message: 'Customer updated successfully'
        });

    } catch (error) {
        console.error('Error updating customer:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// DELETE - Delete customer and all their transactions
router.delete('/:id', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        const userId = req.session.user_id;
        const customerId = parseInt(req.params.id);

        // Check if customer belongs to user
        const customerCheck = await client.query(
            'SELECT id FROM customers WHERE id = $1 AND created_by = $2 AND is_active = true',
            [customerId, userId]
        );

        if (customerCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        await client.query('BEGIN');

        // Soft delete customer (mark as inactive)
        await client.query(
            'UPDATE customers SET is_active = false, updated_at = NOW() WHERE id = $1',
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
        const userId = req.session.user_id;
        const searchValue = sanitizeInput(req.params.value);

        const query = `
            SELECT id, name, mobile_number, village_city, district, state, created_at
            FROM customers 
            WHERE created_by = $1 AND is_active = true 
            AND (name ILIKE $2 OR mobile_number ILIKE $3)
            ORDER BY name
            LIMIT 20
        `;

        const result = await pool.query(query, [userId, `%${searchValue}%`, `%${searchValue}%`]);
        res.json({ success: true, customers: result.rows });

    } catch (error) {
        console.error('Error searching customers:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET customer details
router.get('/details/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user_id;
        const customerId = parseInt(req.params.id);

        const query = `
            SELECT id, name, mobile_number, village_city, district, state, complete_address, pincode, created_at
            FROM customers 
            WHERE id = $1 AND created_by = $2 AND is_active = true
        `;

        const result = await pool.query(query, [customerId, userId]);

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
        const userId = req.session.user_id;
        const customerId = parseInt(req.params.id);

        // Check if customer belongs to user and get all details
        const customerCheck = await pool.query(
            `SELECT id, name, mobile_number, pincode, village_city, district, state, 
                    complete_address, created_at, updated_at 
             FROM customers 
             WHERE id = $1 AND created_by = $2 AND is_active = true`,
            [customerId, userId]
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
