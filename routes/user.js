const router = require('express').Router();
const requireAuth = require('../middleware/auth');
const { db } = require('../db/database');

// GET /api/user/profile
router.get('/profile', requireAuth, (req, res) => {
  const { password_hash, ...safe } = req.user;
  res.json(safe);
});

// GET /api/user/stats
router.get('/stats', requireAuth, (req, res) => {
  const userId = req.user.id;
  const total = db.prepare('SELECT COUNT(*) as count FROM analyses WHERE user_id = ?').get(userId);
  const byDirection = db.prepare(`
    SELECT direction, COUNT(*) as count FROM analyses WHERE user_id = ? GROUP BY direction
  `).all(userId);
  const recent = db.prepare(`
    SELECT asset, timeframe, direction, created_at FROM analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT 5
  `).all(userId);

  res.json({ total_analyses: total.count, by_direction: byDirection, recent });
});

module.exports = router;
