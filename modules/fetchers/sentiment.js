// Chinese sentiment keywords
const POSITIVE_CN = [
  '大涨', '涨停', '牛市', '利好', '突破', '飙升', '强劲', '反弹',
  '增长', '盈利', '回暖', '领涨', '新高', '翻红', '走强', '暴涨',
  '持续向好', '业绩亮眼', '逆势上扬', '全面上涨', '积极', '乐观',
  '扩大', '复苏', '改善', '提升', '繁荣', '稳健', '上升',
];

const NEGATIVE_CN = [
  '大跌', '跌停', '熊市', '利空', '暴跌', '下挫', '跳水', '崩盘',
  '亏损', '下滑', '低迷', '领跌', '新低', '翻绿', '走弱', '重挫',
  '持续下跌', '业绩下滑', '大幅回调', '恐慌', '悲观', '动荡',
  '衰退', '恶化', '萎缩', '危机', '风险', '压力', '下行',
  '制裁', '贸易战', '加息', '通胀', '冲突',
];

// English sentiment keywords
const POSITIVE_EN = [
  'surge', 'rally', 'bull', 'gain', 'growth', 'record high', 'breakthrough',
  'profit', 'recovery', 'optimistic', 'positive', 'expansion', 'boost',
  'outperform', 'upgrade', 'strong', 'soar', 'climb', 'advance',
];

const NEGATIVE_EN = [
  'plunge', 'crash', 'bear', 'loss', 'decline', 'record low', 'fall',
  'recession', 'crisis', 'pessimistic', 'negative', 'contraction', 'cut',
  'underperform', 'downgrade', 'weak', 'tumble', 'drop', 'sell-off',
  'tariff', 'sanction', 'inflation', 'hike', 'conflict',
];

function analyzeText(text, positiveWords, negativeWords) {
  const lower = text.toLowerCase();
  let pos = 0;
  let neg = 0;
  for (const w of positiveWords) {
    if (lower.includes(w)) pos++;
  }
  for (const w of negativeWords) {
    if (lower.includes(w)) neg++;
  }
  return { positive: pos, negative: neg };
}

function getSentimentLabel(score) {
  if (score > 0.2) return 'bullish';
  if (score < -0.2) return 'bearish';
  return 'neutral';
}

function analyzeNews(newsItem) {
  const text = (newsItem.title || '') + ' ' + (newsItem.summary || '');
  const cn = analyzeText(text, POSITIVE_CN, NEGATIVE_CN);
  const en = analyzeText(text, POSITIVE_EN, NEGATIVE_EN);
  const totalPos = cn.positive + en.positive;
  const totalNeg = cn.negative + en.negative;
  const total = totalPos + totalNeg;
  const score = total === 0 ? 0 : (totalPos - totalNeg) / total;
  return { score, label: getSentimentLabel(score), positive: totalPos, negative: totalNeg };
}

// Analyze market sentiment based on market data + news
function analyzeMarketSentiment(marketData, newsItems) {
  // Market-based sentiment from A-share index changes
  let marketScore = 0;
  let count = 0;
  for (const idx of marketData.aShares || []) {
    if (idx.changePercent != null) {
      // Normalize: +2% is very bullish, -2% is very bearish
      marketScore += Math.max(-1, Math.min(1, idx.changePercent / 2));
      count++;
    }
  }
  const marketSentiment = count > 0 ? marketScore / count : 0;

  // News-based sentiment
  let newsScore = 0;
  let newsCount = 0;
  for (const item of (newsItems || []).slice(0, 20)) {
    const s = analyzeNews(item);
    newsScore += s.score;
    newsCount++;
  }
  const newsSentiment = newsCount > 0 ? newsScore / newsCount : 0;

  // Combined
  const combined = marketSentiment * 0.5 + newsSentiment * 0.5;
  let verdict;
  if (combined > 0.3) verdict = '市场情绪偏乐观，多数指标向好';
  else if (combined > 0.05) verdict = '市场情绪略有回暖，保持谨慎乐观';
  else if (combined > -0.05) verdict = '市场情绪中性，多空力量均衡';
  else if (combined > -0.3) verdict = '市场情绪偏谨慎，注意风险控制';
  else verdict = '市场情绪悲观，建议关注防御性板块';

  return {
    score: +combined.toFixed(3),
    marketScore: +marketSentiment.toFixed(3),
    newsScore: +newsSentiment.toFixed(3),
    label: getSentimentLabel(combined),
    verdict: verdict,
  };
}

module.exports = { analyzeNews, analyzeMarketSentiment, getSentimentLabel };
