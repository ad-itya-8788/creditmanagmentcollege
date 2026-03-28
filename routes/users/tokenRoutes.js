const express = require('express');
const pool = require('../../dbconnect');
const { requireAuth } = require('../auth');

const router = express.Router();

// POST /api/users/generate-token - Generate API token for authenticated user
router.post('/generate-token', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user_id;
        const { generateSessionToken } = require('../../utils/tokenAuth');
        
        // Generate a secure token
        const token = generateSessionToken(userId);
        
        // Store token in database (optional - you can implement this)
        // await pool.query('INSERT INTO api_tokens (user_id, token, created_at) VALUES ($1, $2, NOW())', [userId, token]);
        
        res.json({
            success: true,
            token: token,
            message: 'Token generated successfully',
            expiresIn: '24 hours'
        });

    } catch (error) {
        console.error('Error generating token:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to generate token' 
        });
    }
});

// GET /api/users/validate-token - Validate current session token
router.get('/validate-token', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user_id;
        
        // Check if user session is valid
        const userQuery = `
            SELECT user_id, shop_name, owner_name, email 
            FROM users 
            WHERE user_id = $1
        `;
        
        const result = await pool.query(userQuery, [userId]);
        
        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                error: 'Invalid session'
            });
        }

        res.json({
            success: true,
            user: result.rows[0],
            message: 'Token is valid'
        });

    } catch (error) {
        console.error('Error validating token:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to validate token' 
        });
    }
});

// POST /api/users/revoke-token - Revoke current session token
router.post('/revoke-token', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user_id;
        
        // Destroy current session
        req.session.destroy((err) => {
            if (err) {
                console.error('Error revoking token:', err);
                return res.status(500).json({
                    success: false,
                    error: 'Failed to revoke token'
                });
            }
            
            res.clearCookie('agricrm.sid');
            res.json({
                success: true,
                message: 'Token revoked successfully'
            });
        });

    } catch (error) {
        console.error('Error revoking token:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to revoke token' 
        });
    }
});

// GET /api/users/session-info - Get current session information
router.get('/session-info', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user_id;
        
        // Get user information
        const userQuery = `
            SELECT 
                user_id, shop_name, owner_name, email, owner_phone, 
                shop_address, created_at
            FROM users 
            WHERE user_id = $1
        `;
        
        const result = await pool.query(userQuery, [userId]);
        
        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                error: 'User not found'
            });
        }

        // Get session information
        const sessionInfo = {
            sessionId: req.sessionID,
            cookie: req.session.cookie,
            user: result.rows[0],
            isAuthenticated: true
        };

        res.json({
            success: true,
            session: sessionInfo
        });

    } catch (error) {
        console.error('Error getting session info:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to get session info' 
        });
    }
});

module.exports = router;
