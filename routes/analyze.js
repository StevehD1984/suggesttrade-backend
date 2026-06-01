const router = require('express').Router();
const requireAuth = require('../middleware/auth');
const { db } = require('../db/database');

// POST /api/analyze
router.post('/', requireAuth, async (req, res) => {
  const user = req.user;

  // Check credits
  if (user.credits <= 0) {
    return res.status(402).json({ error: 'No credits remaining. Please upgrade your plan.' });
  }

  const { asset, timeframe, context, images } = req.body;
  if (!asset || !timeframe) {
    return res.status(400).json({ error: 'Asset and timeframe are required' });
  }

  // Build message content
  const content = [];

  // Add images if provided (base64)
  if (Array.isArray(images) && images.length > 0) {
    for (const img of images.slice(0, 6)) { // max 6 images
      if (img.data && img.media_type) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.media_type, data: img.data }
        });
      }
    }
  }

  const prompt = `You are SuggestTrade AI, a professional technical analysis assistant. Analyze the provided chart(s) and give a precise, actionable trade suggestion.

Asset: ${asset}
Timeframe: ${timeframe}
${context ? `Trader notes: ${context}` : ''}
${images?.length ? `Charts provided: ${images.length}` : 'No chart image provided — analyze based on asset/timeframe context only.'}

Respond ONLY with a valid JSON object (no markdown, no backticks, no extra text):
{
  "direction": "BUY" or "SELL" or "NEUTRAL",
  "order_type": "Market" or "Limit" or "Stop",
  "entry": "exact price or level",
  "stop_loss": "exact price or level",
  "tp1": "exact price or level",
  "tp2": "exact price or level",
  "lot_suggestion": "e.g. 0.10 for $10,000 account (1% risk)",
  "risk_reward": "e.g. 1:2.5",
  "confidence": "High" or "Medium" or "Low",
  "rationale_en": "2-3 sentences of technical analysis in English",
  "rationale_es": "2-3 sentences of technical analysis in Spanish"
}`;

  content.push({ type: 'text', text: prompt });

  try {
    // Call Anthropic API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', err);
      return res.status(502).json({ error: 'AI service error. Please try again.' });
    }

    const data = await response.json();
    const raw = data.content.map(i => i.text || '').join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    const signal = JSON.parse(clean);

    // Deduct credit atomically
    db.prepare('UPDATE users SET credits = credits - 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

    // Save to history
    db.prepare(`
      INSERT INTO analyses (user_id, asset, timeframe, direction, entry, stop_loss, tp1, tp2, lot_suggestion, risk_reward, confidence, rationale_en, rationale_es, images_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.id, asset, timeframe,
      signal.direction, signal.entry, signal.stop_loss,
      signal.tp1, signal.tp2, signal.lot_suggestion,
      signal.risk_reward, signal.confidence,
      signal.rationale_en, signal.rationale_es,
      images?.length || 0
    );

    // Return signal + updated credits
    const updated = db.prepare('SELECT credits FROM users WHERE id = ?').get(user.id);
    res.json({ signal, credits_remaining: updated.credits });

  } catch (e) {
    console.error('Analyze error:', e);
    res.status(500).json({ error: 'Analysis failed. Please try again.' });
  }
});

// GET /api/analyze/history
router.get('/history', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const rows = db.prepare(
    'SELECT * FROM analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(req.user.id, limit);
  res.json(rows);
});

module.exports = router;
