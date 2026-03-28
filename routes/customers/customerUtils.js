// Input sanitization function
function sanitizeInput(input) {
    if (typeof input !== 'string') return '';
    return input.trim().replace(/[<>]/g, '');
}

// Mobile validation function
function validateMobile(mobile) {
    if (!mobile || typeof mobile !== 'string') return false;
    if (!/^\d{10}$/.test(mobile)) return false;

    const patterns = [
        /^0{10}$/,
        /^1{10}$/,
        /^1234567890$/,
        /^(\d)\1{9}$/
    ];

    return !patterns.some(pattern => pattern.test(mobile));
}

// Calculate credit score based on transaction history
function calculateCreditScore(transactions) {
    if (!transactions || transactions.length === 0) return 500;
    
    const completedTransactions = transactions.filter(t => t.status === 'completed').length;
    const totalTransactions = transactions.length;
    const completionRate = completedTransactions / totalTransactions;
    
    if (completionRate >= 0.8) return 800;
    if (completionRate >= 0.6) return 700;
    if (completionRate >= 0.4) return 600;
    return 400;
}

// Format currency amount
function formatCurrency(amount) {
    return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        minimumFractionDigits: 0
    }).format(amount);
}

// Format date for display
function formatDate(dateString) {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-IN', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

// Validate transaction data
function validateTransactionData(data) {
    const errors = [];
    
    if (!data.transaction_type) {
        errors.push('Transaction type is required');
    }
    
    if (!data.total_amount || isNaN(data.total_amount) || parseFloat(data.total_amount) <= 0) {
        errors.push('Total amount must be a positive number');
    }
    
    if (data.paid_amount && (isNaN(data.paid_amount) || parseFloat(data.paid_amount) < 0)) {
        errors.push('Paid amount must be a non-negative number');
    }
    
    if (data.paid_amount && data.total_amount && parseFloat(data.paid_amount) > parseFloat(data.total_amount)) {
        errors.push('Paid amount cannot exceed total amount');
    }
    
    return errors;
}

module.exports = {
    sanitizeInput,
    validateMobile,
    calculateCreditScore,
    formatCurrency,
    formatDate,
    validateTransactionData
};
