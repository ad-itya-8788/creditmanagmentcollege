const express = require('express');
const pool = require('../dbconnect');

// Import modular user routes for localhost
const userRoutes = require('./users/userRoutes');
const customerApiRoutes = require('./users/customerApiRoutes');
const tokenRoutes = require('./users/tokenRoutes');

const router = express.Router();

// Mount user routes
router.use('/', userRoutes);
router.use('/', customerApiRoutes);
router.use('/', tokenRoutes);

module.exports = router;
