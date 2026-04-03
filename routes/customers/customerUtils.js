const validator = require('validator');

// Utility functions for customer routes
const sanitizeInput = (input) => {
    if (typeof input === 'string') {
        return validator.escape(validator.trim(input));
    }
    return input;
};

const validateMobile = (mobile) => {
    return /^[0-9]{10}$/.test(mobile);
};

module.exports = {
    sanitizeInput,
    validateMobile
};
