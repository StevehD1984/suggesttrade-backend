const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const analyzeRoutes = require('./routes/analyze');
const paymentsRoutes = require('./routes/payments');
const userRoutes = require('./routes/user');

const app = express();

// Security
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 100
});
app.use(limiter);

// Body parsing — raw needed for Stripe webhooks
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '20mb' })); // large for base64 images

// Health check
app.get('/', (req, res) => res.json({ status: 'SuggestTrade AI Backend Online' }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/analyze', analyzeRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/user', userRoutes);

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`SuggestTrade backend running on port ${PORT}`));
