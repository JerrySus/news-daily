require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Reuse existing fetcher modules
const { fetchAllNews } = require('./modules/fetchers/news');
const { fetchAllMarketData } = require('./modules/fetchers/stocks');

const DOCS_DIR = path.join(__dirname, 'docs');
const ARCHIVE_DIR = path.join(DOCS_DIR, 'archive');

// --- DeepSeek API Client ---
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';

async function callDeepSeek(messages, maxTokens = 4096) {
  if (!DEEPSEEK_API_KEY) {
    console.error('[deepseek] No API key. Set DEEPSEEK_API_KEY in env.');
    return null;
  }

  const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[deepseek] API error:', res.status, err);
    return null;
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || null;
}

// --- Build the analysis prompt ---
function buildAnalysisPrompt(marketData, newsItems) {
  // Market summary
  let marketSummary = '';
  for (const idx of (marketData.aShares || [])) {
    const sign = idx.changePercent > 0 ? '+' : '';
    marketSummary += `- ${idx.name}: ${idx.price?.toFixed(2)} (${sign}${idx.changePercent?.toFixed(2)}%)\n`;
  }
  for (const idx of (marketData.usShares || [])) {
    const sign = idx.changePercent > 0 ? '+' : '';
    marketSummary += `- ${idx.name}: ${idx.price?.toFixed(2)} (${sign}${idx.changePercent?.toFixed(2)}%)\n`;
  }

  // News list (take top 20, deduplicated)
  const topNews = (newsItems || []).slice(0, 20);
  let newsList = '';
  topNews.forEach((n, i) => {
    newsList += `${i + 1}. [${n.source}] ${n.title}\n`;
    if (n.summary) newsList += `   摘要: ${n.summary.slice(0, 100)}\n`;
  });

  const today = new Date().toISOString().slice(0, 10);

  return `你是一位资深证券市场分析师。请基于今日重大新闻，分析对A股、港股、美股市场的潜在影响。

【今日市场行情】
${marketSummary || '暂无数据'}

【今日重大新闻】
${newsList || '暂无新闻'}

【分析要求】
请对每条新闻逐条进行分析，并输出JSON格式。注意：
1. 不仅限于财经新闻——科技突破、政策变化、国际关系、行业监管、自然灾害等都要考虑
2. affected_industries: 具体受影响的行业（如"半导体""新能源""消费电子""房地产"等）
3. affected_companies: 可能受影响的上市公司名称和代码（如"宁德时代(300750)"），如果没有具体公司可以写"行业整体"
4. direction: 判断是"利好"还是"利空"还是"中性"
5. impact_level: 影响强度，"强"/"中"/"弱"
6. analysis: 简要分析背后的逻辑链条，80字以内
7. suggestion: 给出具体的短期或中期投资建议，50字以内

【输出格式】
严格按以下JSON数组格式输出，不要有其他文字：

[
  {
    "news_title": "新闻标题",
    "affected_industries": ["行业A", "行业B"],
    "affected_companies": ["公司名(代码)"],
    "direction": "利好",
    "impact_level": "强",
    "analysis": "逻辑分析...",
    "suggestion": "投资建议..."
  }
]

只输出JSON数组，不要加任何markdown代码块标记。`;
}

// --- Generate analysis via DeepSeek ---
async function analyzeNews(marketData, newsData) {
  if (!newsData?.items?.length) {
    console.log('[analyze] No news to analyze');
    return [];
  }

  if (!DEEPSEEK_API_KEY) {
    console.log('[analyze] No DeepSeek API key, using rule-based fallback');
    return fallbackAnalysis(marketData, newsData.items);
  }

  const prompt = buildAnalysisPrompt(marketData, newsData.items);
  console.log(`[analyze] Sending ${newsData.items.length} news items to DeepSeek...`);

  const response = await callDeepSeek([
    { role: 'system', content: '你是一位专业证券市场分析师。只输出JSON,不加markdown标记。' },
    { role: 'user', content: prompt },
  ]);

  if (!response) {
    console.log('[analyze] DeepSeek failed, using fallback');
    return fallbackAnalysis(marketData, newsData.items);
  }

  try {
    // Try to extract JSON from response (in case model adds extra text)
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log(`[analyze] DeepSeek returned ${parsed.length} analyses`);
      return parsed;
    }
    return JSON.parse(response);
  } catch (e) {
    console.error('[analyze] Failed to parse DeepSeek response:', e.message);
    console.error('[analyze] Raw response:', response.slice(0, 500));
    return fallbackAnalysis(marketData, newsData.items);
  }
}

// --- Rule-based fallback (when API key not available) ---
const { analyzeNews: keywordAnalyze } = require('./modules/fetchers/sentiment');

function fallbackAnalysis(marketData, newsItems) {
  return newsItems.slice(0, 15).map((item) => {
    const sentiment = keywordAnalyze(item);
    const direction = sentiment.label === 'bullish' ? '利好' : sentiment.label === 'bearish' ? '利空' : '中性';

    // Simple keyword-based industry matching
    const industries = [];
    const text = item.title + (item.summary || '');
    const industryKeywords = {
      '半导体': ['芯片', '半导体', '光刻', '晶圆', 'AI芯片', 'GPU', '算力'],
      '新能源': ['光伏', '锂电', '电池', '储能', '风电', '新能源', '宁德'],
      '消费电子': ['手机', '消费电子', '耳机', '可穿戴'],
      '人工智能': ['AI', '人工智能', '大模型', 'GPT', '智能', '机器人'],
      '医药': ['医药', '创新药', '疫苗', '医疗器械', '生物'],
      '房地产': ['房地产', '楼市', '房价', '房企', '购房'],
      '汽车': ['汽车', '新能源车', '电动车', '智能驾驶', '特斯拉', '比亚迪'],
      '金融': ['银行', '券商', '保险', '利率', '降息', '加息', '央行'],
      '互联网': ['互联网', '平台', '社交', '电商', '腾讯', '阿里', '字节'],
      '军工': ['军工', '国防', '导弹', '航母', '航天'],
      '消费': ['消费', '白酒', '食品', '零售', '餐饮', '旅游'],
    };

    for (const [ind, keywords] of Object.entries(industryKeywords)) {
      if (keywords.some((kw) => text.includes(kw))) {
        industries.push(ind);
      }
    }

    return {
      news_title: item.title,
      affected_industries: industries.length > 0 ? [...new Set(industries)].slice(0, 3) : ['需进一步分析'],
      affected_companies: ['待AI分析'],
      direction,
      impact_level: sentiment.label === 'neutral' ? '弱' : '中',
      analysis: `基于关键词分析，该新闻${direction === '利好' ? '可能提振' : direction === '利空' ? '可能打压' : '暂难判断影响'}相关板块。`,
      suggestion: direction === '利好' ? '可关注相关板块短期机会' : direction === '利空' ? '建议暂时回避，等待企稳' : '建议观望',
    };
  });
}

// --- HTML Generation ---
function formatChange(n) {
  if (n == null) return '<span class="na">--</span>';
  const cls = n > 0 ? 'up' : n < 0 ? 'down' : '';
  return `<span class="${cls}">${n > 0 ? '+' : ''}${n.toFixed(2)}%</span>`;
}

function buildMarketCards(marketData) {
  let html = '';
  const all = [...(marketData.aShares || []), ...(marketData.usShares || [])];
  for (const m of all) {
    const dir = m.changePercent > 0 ? 'up' : m.changePercent < 0 ? 'down' : '';
    html += `<div class="mc">
      <div class="mc-name">${m.name} <span class="mc-code">${m.code}</span></div>
      <div class="mc-price">${m.price?.toFixed(2)}</div>
      <div class="mc-chg ${dir}">${m.changePercent > 0 ? '+' : ''}${m.changePercent?.toFixed(2)}%</div>
    </div>`;
  }
  return html;
}

function buildAnalysisCards(analyses) {
  if (!analyses?.length) return '<p>暂无分析结果</p>';

  let html = '';
  const summaryMap = {};

  for (const a of analyses) {
    const dirClass = a.direction === '利好' ? 'bullish' : a.direction === '利空' ? 'bearish' : 'neutral';
    const dirEmoji = a.direction === '利好' ? '📈' : a.direction === '利空' ? '📉' : '➖';
    const impactBadge = a.impact_level === '强' ? '<span class="badge badge-strong">强影响</span>' :
      a.impact_level === '中' ? '<span class="badge badge-mid">中影响</span>' :
      '<span class="badge badge-weak">弱影响</span>';

    html += `<div class="card ${dirClass}">
      <div class="card-header">
        <span class="card-dir">${dirEmoji} ${a.direction}</span>
        ${impactBadge}
        <span class="card-date">${a.news_title}</span>
      </div>
      <div class="card-body">
        <div class="card-row"><strong>影响行业:</strong> ${(a.affected_industries || []).join('、') || '待分析'}</div>
        <div class="card-row"><strong>相关公司:</strong> ${(a.affected_companies || []).join('、') || '待分析'}</div>
        <div class="card-row analysis">${a.analysis || ''}</div>
        <div class="card-row suggestion">💡 ${a.suggestion || ''}</div>
      </div>
    </div>`;

    // Build summary
    const dirKey = a.direction;
    if (!summaryMap[dirKey]) summaryMap[dirKey] = { count: 0, industries: new Set() };
    summaryMap[dirKey].count++;
    (a.affected_industries || []).forEach((ind) => summaryMap[dirKey].industries.add(ind));
  }

  return { cardsHtml: html, summaryMap };
}

function buildSummaryBox(summaryMap) {
  let html = '<div class="summary-box"><h3>今日投资情绪汇总</h3>';
  for (const [dir, data] of Object.entries(summaryMap)) {
    const emoji = dir === '利好' ? '📈' : dir === '利空' ? '📉' : '➖';
    const industries = [...data.industries].slice(0, 8).join('、');
    html += `<div class="summary-row">
      <span class="summary-dir">${emoji} ${dir} (${data.count}条)</span>
      ${industries ? `<span class="summary-ind">涉及: ${industries}</span>` : ''}
    </div>`;
  }
  html += '</div>';
  return html;
}

async function generateHtml(marketData, analyses, dateStr) {
  const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
  const dayOfWeek = dayNames[new Date(dateStr).getDay()];
  const { cardsHtml, summaryMap } = buildAnalysisCards(analyses);
  const summaryHtml = buildSummaryBox(summaryMap);

  const template = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI 投资分析日报 - ${dateStr}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,"Microsoft YaHei",sans-serif;background:#0f0f14;color:#e0e0e0;line-height:1.6;min-height:100vh}
.header{background:linear-gradient(135deg,#1a1a2e,#16213e,#0f3460);padding:28px 20px;text-align:center;border-bottom:1px solid #2a2a3e}
.header h1{font-size:22px;color:#e15241;margin-bottom:4px}
.header .date{font-size:14px;color:#888}
.header .badge-row{margin-top:8px;display:flex;gap:6px;justify-content:center;flex-wrap:wrap}
.container{max-width:800px;margin:0 auto;padding:16px}
.nav{display:flex;gap:8px;margin-bottom:20px}
.nav a{color:#e15241;text-decoration:none;font-size:13px;padding:6px 12px;background:#1a1a2e;border-radius:6px;border:1px solid #2a2a3e}
.nav a:hover{background:#2a2a3e}
.section-title{font-size:16px;font-weight:600;margin:20px 0 12px;padding-left:10px;border-left:3px solid #e15241}
.market-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:16px}
.mc{background:#1a1a2e;border-radius:10px;padding:14px;border:1px solid #2a2a3e}
.mc-name{font-size:12px;color:#888}
.mc-code{color:#555;font-size:10px}
.mc-price{font-size:20px;font-weight:700;margin:4px 0;color:#f0f0f0}
.mc-chg{font-size:13px;font-weight:600}
.mc-chg.up{color:#e15241}
.mc-chg.down{color:#1aad19}
.summary-box{background:#1a1a2e;border-radius:10px;padding:16px;margin-bottom:20px;border:1px solid #2a2a3e}
.summary-box h3{font-size:15px;margin-bottom:10px}
.summary-row{padding:6px 0;font-size:13px;border-bottom:1px solid #2a2a3e}
.summary-dir{font-weight:600}
.summary-ind{color:#888;margin-left:8px}
.card{border-radius:10px;padding:16px;margin-bottom:12px;border:1px solid #2a2a3e;background:#1a1a2e}
.card.bullish{border-left:3px solid #e15241}
.card.bearish{border-left:3px solid #1aad19}
.card.neutral{border-left:3px solid #666}
.card-header{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.card-dir{font-weight:700;font-size:14px}
.card-date{font-size:13px;color:#aaa;flex:1}
.badge{font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600}
.badge-strong{background:rgba(225,82,65,.2);color:#e15241}
.badge-mid{background:rgba(255,193,7,.2);color:#ffc107}
.badge-weak{background:rgba(102,102,102,.2);color:#999}
.card-row{margin-bottom:4px;font-size:13px}
.card-row.analysis{color:#bbb;margin-top:6px;padding:8px;background:rgba(255,255,255,.03);border-radius:6px}
.card-row.suggestion{color:#e15241;margin-top:6px;font-weight:500}
.footer{text-align:center;padding:30px;color:#555;font-size:12px}
.na{color:#666}
@media(max-width:480px){.market-grid{grid-template-columns:repeat(2,1fr)}.header h1{font-size:18px}}
</style>
</head>
<body>
<div class="header">
  <h1>AI 投资分析日报</h1>
  <div class="date">${dateStr} 星期${dayOfWeek}</div>
  <div class="badge-row">
    <span class="badge badge-strong">AI分析师: DeepSeek</span>
    <span class="badge badge-mid">仅供参考，不构成投资建议</span>
  </div>
</div>

<div class="container">
  <div class="nav">
    <a href="/">首页</a>
    <a href="/archive/">历史日报</a>
  </div>

  <div class="section-title">市场行情</div>
  <div class="market-grid">${buildMarketCards(marketData)}</div>

  ${summaryHtml}

  <div class="section-title">AI 逐条分析</div>
  ${cardsHtml}

  <div class="footer">
    <p>AI 投资分析日报 &middot; 每日 8:00 自动生成</p>
    <p style="margin-top:4px">分析由 DeepSeek AI 生成，数据来源于新浪财经、东方财富等公开渠道</p>
    <p style="margin-top:4px;color:#e15241">⚠ 以上分析仅供参考，不构成任何投资建议。投资有风险，入市需谨慎。</p>
  </div>
</div>
</body>
</html>`;

  return template;
}

// --- Archive index page ---
function generateArchiveIndex(dates) {
  let links = '';
  for (const d of dates) {
    links += `<div class="archive-item"><a href="/archive/${d}.html">${d}</a></div>`;
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>历史日报 - AI 投资分析日报</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,"Microsoft YaHei",sans-serif;background:#0f0f14;color:#e0e0e0;line-height:1.6}
.header{background:linear-gradient(135deg,#1a1a2e,#16213e);padding:28px 20px;text-align:center;border-bottom:1px solid #2a2a3e}
.header h1{font-size:22px;color:#e15241}
.container{max-width:600px;margin:0 auto;padding:16px}
.archive-item{padding:12px;border-bottom:1px solid #2a2a3e}
.archive-item a{color:#e15241;text-decoration:none;font-size:16px}
.archive-item a:hover{text-decoration:underline}
.back-link{display:inline-block;margin-bottom:16px;color:#888;text-decoration:none;font-size:13px}
.footer{text-align:center;padding:30px;color:#555;font-size:12px}
</style>
</head>
<body>
<div class="header"><h1>历史日报</h1></div>
<div class="container">
  <a href="/" class="back-link">← 返回首页</a>
  ${links || '<p>暂无历史日报</p>'}
  <div class="footer"><p>AI 投资分析日报 &middot; 每日自动生成</p></div>
</div>
</body>
</html>`;
}

// --- Main ---
async function main() {
  console.log('[generate] Starting daily digest generation...');
  console.log('[generate] DeepSeek API:', DEEPSEEK_API_KEY ? 'configured' : 'not configured (fallback mode)');

  // Ensure directories
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  const todayStr = new Date().toISOString().slice(0, 10);

  // Fetch data
  console.log('[generate] Fetching news and market data...');
  const [newsData, marketData] = await Promise.all([
    fetchAllNews(),
    fetchAllMarketData(),
  ]);
  console.log(`[generate] News: ${newsData.count} items, Market: ${marketData.aShares.length + marketData.usShares.length} indices`);

  // AI Analysis
  console.log('[generate] Running AI analysis...');
  const analyses = await analyzeNews(marketData, newsData);

  // Generate HTML
  console.log('[generate] Generating HTML...');
  const html = await generateHtml(marketData, analyses, todayStr);

  // Write today's page
  const todayPath = path.join(DOCS_DIR, 'today.html');
  fs.writeFileSync(todayPath, html);
  console.log(`[generate] Written: ${todayPath}`);

  // Also write as index.html for the main page
  const indexPath = path.join(DOCS_DIR, 'index.html');
  fs.writeFileSync(indexPath, html);
  console.log(`[generate] Written: ${indexPath}`);

  // Write archive copy
  const archivePath = path.join(ARCHIVE_DIR, `${todayStr}.html`);
  fs.writeFileSync(archivePath, html);
  console.log(`[generate] Written: ${archivePath}`);

  // Save raw data as JSON
  const jsonPath = path.join(ARCHIVE_DIR, `${todayStr}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ date: todayStr, marketData, newsData, analyses }, null, 2));
  console.log(`[generate] Written: ${jsonPath}`);

  // Update archive index
  const existingFiles = fs.readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
  existingFiles.sort().reverse();
  const archiveIndexHtml = generateArchiveIndex(existingFiles);
  fs.writeFileSync(path.join(DOCS_DIR, 'archive.html'), archiveIndexHtml);

  // Optional: send email
  if (process.env.SMTP_HOST && process.env.SMTP_USER) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT) || 465,
        secure: true,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transporter.sendMail({
        from: `"AI投资日报" <${process.env.SMTP_USER}>`,
        to: process.env.SMTP_TO || process.env.SMTP_USER,
        subject: `AI投资分析日报 - ${todayStr}`,
        html: html,
      });
      console.log('[generate] Email sent');
    } catch (e) {
      console.error('[generate] Email failed:', e.message);
    }
  }

  console.log('[generate] Done!');
}

main().catch((err) => {
  console.error('[generate] Fatal error:', err);
  process.exit(1);
});
