const express = require('express');
const bcrypt = require('bcrypt');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const pool = require('../dbconnect');
const validator = require('validator');
const path = require('path');
const fs = require('fs');

const router = express.Router();

const sessionStore = new pgSession({
    pool: pool,
    tableName: 'session',
    createTableIfMissing: true,
    ttl: 24 * 60 * 60
});

const sessionMiddleware = session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    },
    name: 'agricrm.sid'
});

// Auth middleware
const requireAuth = async (req, res, next) => {
    try {
        if (req.session && req.session.admin_id) {
            const result = await pool.query(
                `SELECT admin_id, shop_name, owner_name, owner_phone, shop_address,
                        pincode, tehsil, district, email, shop_image
                 FROM admin
                 WHERE admin_id = $1`,
                [req.session.admin_id]
            );

            if (result.rows.length > 0) {
                req.user = result.rows[0];
                next();
            } else {
                req.session.destroy();
                res.redirect('/login');
            }
        } else {
            res.redirect('/login');
        }
    } catch (error) {
        console.error('Auth middleware error:', error);
        res.redirect('/login');
    }
};

const sanitizeInput = (input) => {
    if (typeof input === 'string') {
        return validator.escape(validator.trim(input));
    }
    return input;
};

// Serve login page
router.get('/login', (req, res) => {
    const loginPath = path.join(__dirname, '../public/login.html');
    if (fs.existsSync(loginPath)) {
        res.sendFile(loginPath);
    } else {
        res.status(404).send('Login page not found');
    }
});

// Serve signup page
router.get('/signup', (req, res) => {
    const signupPath = path.join(__dirname, '../public/signup.html');
    if (fs.existsSync(signupPath)) {
        res.sendFile(signupPath);
    } else {
        res.status(404).send('Signup page not found');
    }
});

// Register
router.post('/register', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const {
            shop_name, owner_name, owner_phone, shop_address,
            pincode, email, password, confirm_password, tehsil, district
        } = req.body;

        const sanitizedData = {
            shop_name: sanitizeInput(shop_name),
            owner_name: sanitizeInput(owner_name),
            owner_phone: sanitizeInput(owner_phone),
            shop_address: sanitizeInput(shop_address),
            pincode: sanitizeInput(pincode),
            email: sanitizeInput(email).toLowerCase(),
            tehsil: sanitizeInput(tehsil),
            district: sanitizeInput(district)
        };

        if (!sanitizedData.shop_name || !sanitizedData.owner_name || !sanitizedData.owner_phone ||
            !sanitizedData.shop_address || !sanitizedData.email || !password) {
            return res.status(400).json({ error: 'All required fields must be provided' });
        }

        if (password !== confirm_password) {
            return res.status(400).json({ error: 'Passwords do not match' });
        }

        if (!validator.isEmail(sanitizedData.email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        if (!/^[0-9]{10}$/.test(sanitizedData.owner_phone)) {
            return res.status(400).json({ error: 'Please enter a valid 10-digit phone number' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters long' });
        }

        const emailCheck = await client.query(
            'SELECT admin_id FROM admin WHERE email = $1',
            [sanitizedData.email]
        );
        if (emailCheck.rows.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        const phoneCheck = await client.query(
            'SELECT admin_id FROM admin WHERE owner_phone = $1',
            [sanitizedData.owner_phone]
        );
        if (phoneCheck.rows.length > 0) {
            return res.status(400).json({ error: 'Phone number already registered' });
        }

        const hashedPassword = await bcrypt.hash(password, 12);

        const result = await client.query(
            `INSERT INTO admin (shop_name, owner_name, owner_phone, shop_address, pincode, email, password, tehsil, district)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING admin_id, shop_name, owner_name, email`,
            [sanitizedData.shop_name, sanitizedData.owner_name, sanitizedData.owner_phone,
             sanitizedData.shop_address, sanitizedData.pincode, sanitizedData.email,
             hashedPassword, sanitizedData.tehsil, sanitizedData.district]
        );

        const user = result.rows[0];

        req.session.admin_id = user.admin_id;
        req.session.shop_name = user.shop_name;
        req.session.owner_name = user.owner_name;
        req.session.email = user.email;

        await client.query('COMMIT');

        res.status(201).json({
            message: 'Registration successful',
            user: {
                admin_id: user.admin_id,
                shop_name: user.shop_name,
                owner_name: user.owner_name,
                email: user.email
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// Login
router.post('/login', async (req, res) => {
    try {
        const { identifier, password } = req.body;

        if (!identifier || !password) {
            return res.status(400).json({ error: 'Email/phone and password are required' });
        }

        const sanitizedIdentifier = sanitizeInput(identifier);

        let result;
        if (sanitizedIdentifier.includes('@')) {
            result = await pool.query(
                'SELECT admin_id, shop_name, owner_name, email, password FROM admin WHERE email = $1',
                [sanitizedIdentifier.toLowerCase()]
            );
        } else {
            result = await pool.query(
                'SELECT admin_id, shop_name, owner_name, email, password FROM admin WHERE owner_phone = $1',
                [sanitizedIdentifier]
            );
        }

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid email/phone or password' });
        }

        const user = result.rows[0];

        if (!user.password) {
            return res.status(401).json({ error: 'Invalid email/phone or password' });
        }

        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            return res.status(401).json({ error: 'Invalid email/phone or password' });
        }

        req.session.admin_id = user.admin_id;
        req.session.shop_name = user.shop_name;
        req.session.owner_name = user.owner_name;
        req.session.email = user.email;

        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ error: 'Session save failed' });
            }

            res.json({
                message: 'Login successful',
                user: {
                    admin_id: user.admin_id,
                    shop_name: user.shop_name,
                    owner_name: user.owner_name,
                    email: user.email
                }
            });
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Logout
router.post('/logout', requireAuth, async (req, res) => {
    try {
        req.session.destroy((err) => {
            if (err) {
                console.error('Logout error:', err);
                return res.status(500).json({ error: 'Error during logout' });
            }
            res.clearCookie('agricrm.sid');
            res.json({ message: 'Logout successful' });
        });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});


module.exports = {
    router,
    requireAuth,
    sessionMiddleware,
    sessionStore
};
