const express = require('express');
const pool = require('../dbconnect');

// Import modular customer routes for localhost
const customerRoutes = require('./customers/customerRoutes');
const transactionRoutes = require('./customers/transactionRoutes');

const router = express.Router();

// Mount customer routes
router.use('/', customerRoutes);
router.use('/', transactionRoutes);

module.exports = router;
