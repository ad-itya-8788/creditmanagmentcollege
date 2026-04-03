const validator = require('validator');

// Clean a text input: trim spaces and escape special characters
function sanitizeInput(input) {
    if (typeof input === 'string') {
        return validator.escape(validator.trim(input));
    }
    return input;
}

// Check if a mobile number is exactly 10 digits
function validateMobile(mobile) {
    return /^[0-9]{10}$/.test(mobile);
}

module.exports = { sanitizeInput, validateMobile };
