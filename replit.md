# AgriCRM - Agricultural Credit Score System

## Overview
AgriCRM is a web-based CRM application designed for agricultural shops (fertilizer shops, etc.) to manage customer credits, transactions, and payment history.

## Tech Stack
- **Runtime:** Node.js (>=18)
- **Framework:** Express.js with EJS server-side templating
- **Database:** PostgreSQL (Replit built-in)
- **Authentication:** express-session with connect-pg-simple (session stored in DB)
- **Password hashing:** bcrypt
- **Security:** helmet, express-rate-limit
- **PDF generation:** pdfkit, puppeteer

## Project Structure
- `index.js` - Main Express app entry point
- `dbconnect.js` - PostgreSQL connection using `DATABASE_URL` env var
- `routes/auth.js` - Authentication routes, session middleware, requireAuth guard
- `routes/customer.js` - Customer routes
- `routes/customers/` - Transaction and customer utilities
- `routes/users/` - User/profile routes
- `views/` - EJS templates for dashboard, customers, reports, settings, etc.
- `public/` - Static assets (HTML, CSS, images) for public pages
- `protected/` - Protected HTML (add customer form)
- `database.sql` - Database schema

## Database Schema
- `users` - Shop owners/admin accounts
- `customers` - Customer records linked to users
- `customer_transactions` - Credits, payments, status tracking
- `payment_logs` - Payment history
- `session` - Express session storage

## Environment Variables
- `DATABASE_URL` - PostgreSQL connection string (Replit managed)
- `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` - DB connection details
- `SESSION_SECRET` - Secret for express-session (set as Replit secret)
- `PORT` - Server port (set to 5000)
- `NODE_ENV` - Environment (development/production)

## Running the App
- **Dev workflow:** `node index.js` on port 5000
- **Server binds to:** `0.0.0.0:5000` for Replit preview compatibility

## Key Routes
- `/` - Landing page
- `/login` - Login page
- `/signup` - Registration page
- `/dashboard` - Main dashboard (auth required)
- `/customers` - Customer list (auth required)
- `/report` - Reports (auth required)
- `/settings` - User settings (auth required)
- `/auth/*` - Auth API endpoints
- `/customers/*` - Customer API endpoints
- `/api/users/*` - User API endpoints
