const router = require('express').Router();
const requireAuth = require('../middleware/auth');
const { db, PLANS } = require('../db/database');

// ─── STRIPE ────────────────────────────────────────────────────────────────

// POST /api/payments/stripe/create-checkout
router.post('/stripe/create-checkout', requireAuth, async (req, res) => {
  const { plan } = req.body;
  if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

  // Get or create Stripe customer
  let customerId = req.user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: req.user.email,
      name: req.user.name,
      metadata: { user_id: String(req.user.id) }
    });
    customerId = customer.id;
    db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, req.user.id);
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ['card'],
    mode: 'subscription',
    line_items: [{
      price: process.env[`STRIPE_PRICE_${plan.toUpperCase()}`],
      quantity: 1
    }],
    success_url: `${process.env.FRONTEND_URL}/app?payment=success&plan=${plan}`,
    cancel_url: `${process.env.FRONTEND_URL}?payment=cancelled`,
    metadata: { user_id: String(req.user.id), plan }
  });

  res.json({ url: session.url });
});

// POST /api/payments/webhook (Stripe — raw body)
router.post('/webhook', async (req, res) => {
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).json({ error: `Webhook signature failed: ${e.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = parseInt(session.metadata.user_id);
    const plan = session.metadata.plan;

    if (userId && plan && PLANS[plan]) {
      const end = new Date();
      end.setMonth(end.getMonth() + 1);

      db.prepare(`
        UPDATE users SET
          plan = ?,
          credits = credits + ?,
          stripe_subscription_id = ?,
          subscription_status = 'active',
          subscription_end = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(plan, PLANS[plan].credits, session.subscription, end.toISOString().split('T')[0], userId);

      db.prepare(`
        INSERT INTO payments (user_id, provider, provider_payment_id, amount_usd, plan, status)
        VALUES (?, 'stripe', ?, ?, ?, 'completed')
      `).run(userId, session.id, PLANS[plan].price_usd, plan);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    db.prepare(`
      UPDATE users SET subscription_status = 'inactive', plan = 'free', updated_at = CURRENT_TIMESTAMP
      WHERE stripe_subscription_id = ?
    `).run(sub.id);
  }

  res.json({ received: true });
});

// ─── PAYPAL ────────────────────────────────────────────────────────────────

async function getPaypalToken() {
  const res = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await res.json();
  return data.access_token;
}

// POST /api/payments/paypal/create-order
router.post('/paypal/create-order', requireAuth, async (req, res) => {
  const { plan } = req.body;
  if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });

  try {
    const token = await getPaypalToken();
    const response = await fetch('https://api-m.paypal.com/v2/checkout/orders', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: { currency_code: 'USD', value: String(PLANS[plan].price_usd) },
          description: `SuggestTrade AI — ${plan} plan`,
          custom_id: `${req.user.id}:${plan}`
        }],
        application_context: {
          return_url: `${process.env.FRONTEND_URL}/app?payment=success&plan=${plan}`,
          cancel_url: `${process.env.FRONTEND_URL}?payment=cancelled`
        }
      })
    });

    const order = await response.json();
    const approvalUrl = order.links?.find(l => l.rel === 'approve')?.href;
    res.json({ order_id: order.id, approval_url: approvalUrl });
  } catch (e) {
    res.status(500).json({ error: 'PayPal order creation failed' });
  }
});

// POST /api/payments/paypal/capture
router.post('/paypal/capture', requireAuth, async (req, res) => {
  const { order_id, plan } = req.body;
  if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });

  try {
    const token = await getPaypalToken();
    const response = await fetch(`https://api-m.paypal.com/v2/checkout/orders/${order_id}/capture`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    const capture = await response.json();

    if (capture.status === 'COMPLETED') {
      const end = new Date();
      end.setMonth(end.getMonth() + 1);

      db.prepare(`
        UPDATE users SET
          plan = ?, credits = credits + ?,
          subscription_status = 'active',
          subscription_end = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(plan, PLANS[plan].credits, end.toISOString().split('T')[0], req.user.id);

      db.prepare(`
        INSERT INTO payments (user_id, provider, provider_payment_id, amount_usd, plan, status)
        VALUES (?, 'paypal', ?, ?, ?, 'completed')
      `).run(req.user.id, order_id, PLANS[plan].price_usd, plan);

      const updated = db.prepare('SELECT credits, plan FROM users WHERE id = ?').get(req.user.id);
      res.json({ success: true, credits: updated.credits, plan: updated.plan });
    } else {
      res.status(402).json({ error: 'Payment not completed' });
    }
  } catch (e) {
    res.status(500).json({ error: 'PayPal capture failed' });
  }
});

// GET /api/payments/status
router.get('/status', requireAuth, (req, res) => {
  const user = db.prepare('SELECT plan, credits, subscription_status, subscription_end FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

module.exports = router;
