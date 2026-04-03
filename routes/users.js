const express = require('express');
const pool = require('../dbconnect');

// Import modular user routes (token routes removed)
const userRoutes = require('./users/userRoutes');
const customerApiRoutes = require('./users/customerApiRoutes');

const router = express.Router();

// Mount user routes
router.use('/', userRoutes);
router.use('/', customerApiRoutes);

module.exports = router;
