require('dotenv').config();
const express = require('express');
const path = require('path');
const { generateDigest, loadDigest, listDigests } = require('./modules/digest');
const { fetchAllNews } = require('./modules/fetchers/news');
const { fetchAllMarketData } = require('./modules/fetchers/stocks');
const { analyzeMarketSentiment } = require('./modules/fetchers/sentiment');
const { initMailer, sendDailyDigest } = require('./modules/mailer');
const { startScheduler } = require('./modules/scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Also serve data directory for historical digests
app.use('/data', express.static(path.join(__dirname, 'data')));

// API: Generate and get today's digest
app.get('/api/generate', async (req, res) => {
  try {
    const { digest, html } = await generateDigest();
    res.json(digest);
  } catch (err) {
    console.error('[api] generate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// API: Generate and send via email
app.get('/api/send', async (req, res) => {
  try {
    const { digest, html } = await generateDigest();
    const result = await sendDailyDigest(html, digest.date);
    res.json({ digest: { date: digest.date }, mail: result });
  } catch (err) {
    console.error('[api] send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// API: Get today's digest (from cache if exists)
app.get('/api/digest/today', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  let digest = loadDigest(today);
  if (!digest) {
    // Generate if not yet available
    try {
      const result = await generateDigest();
      digest = result.digest;
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  res.json(digest);
});

// API: Get specific date's digest
app.get('/api/digest/:date', (req, res) => {
  const digest = loadDigest(req.params.date);
  if (!digest) {
    return res.status(404).json({ error: 'Digest not found for this date' });
  }
  res.json(digest);
});

// API: List available digests
app.get('/api/digests', (req, res) => {
  res.json({ dates: listDigests() });
});

// API: Live market data only
app.get('/api/market/now', async (req, res) => {
  try {
    const data = await fetchAllMarketData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Live news only
app.get('/api/news/now', async (req, res) => {
  try {
    const data = await fetchAllNews();
    data.items = data.items.map((item) => {
      const { analyzeNews } = require('./modules/fetchers/sentiment');
      return { ...item, sentiment: analyzeNews(item) };
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Initialize mailer and scheduler
initMailer();
startScheduler();

app.listen(PORT, () => {
  console.log(`News Daily server running at http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api/generate`);
  console.log(`Dashboard: http://localhost:${PORT}/`);
});
