require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

// Reuse existing fetcher modules
const { fetchAllNews } = require('./modules/fetchers/news');
const { fetchAllMarketData } = require('./modules/fetchers/stocks');

const DOCS_DIR = path.join(__dirname, 'docs');
const ARCHIVE_DIR = path.join(DOCS_DIR, 'archive');

// --- DeepSeek API Client ---
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';

// --- Web search tool ---
// DeepSeek API has no built-in web search, so we expose one via tool calls.
// Backed by Bing/Baidu HTML scrape — no extra API key required.
const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: '联网搜索网页，获取最新信息。用于核实上市公司股票代码、基金代码是否存在，以及新闻事件的后续进展与背景资料。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，中文，具体明确，如"行云科技 688365 主营业务"' },
      },
      required: ['query'],
    },
  },
};

async function webSearch(query, num = 5) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const endpoints = [
    { url: `https://cn.bing.com/search?q=${encodeURIComponent(query)}`, sel: 'li.b_algo' },
    { url: `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`, sel: 'div.result, div.c-container' },
  ];
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep.url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const $ = cheerio.load(await res.text());
      const results = [];
      $(ep.sel).each((_, el) => {
        if (results.length >= num) return false;
        const title = $(el).find('h2, h3').first().text().trim();
        const link = $(el).find('a').first().attr('href') || '';
        const snippet = $(el).find('p, .c-abstract, .b_caption span, .c-span-last').first().text().trim();
        if (title && title.length > 4) results.push({ title, url: link, snippet: snippet.slice(0, 200) });
      });
      if (results.length) {
        console.log(`[web_search] "${query}" -> ${results.length} results (${new URL(ep.url).hostname})`);
        return { query, results };
      }
    } catch (e) {
      console.log(`[web_search] ${new URL(ep.url).hostname} failed: ${e.message}`);
    }
  }
  console.log(`[web_search] "${query}" -> no results`);
  return { query, results: [], note: '搜索暂不可用，请基于已有新闻信息分析' };
}

// Run one DeepSeek conversation, executing web_search tool calls on demand.
// MAX_TOOL_ROUNDS bounds latency/cost per batch.
const MAX_TOOL_ROUNDS = 3;

async function callDeepSeek(messages, maxTokens = 32768, maxToolRounds = MAX_TOOL_ROUNDS) {
  if (!DEEPSEEK_API_KEY) {
    console.error('[deepseek] No API key. Set DEEPSEEK_API_KEY in env.');
    return null;
  }

  let convo = [...messages];

  for (let round = 0; round < maxToolRounds; round++) {
    const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: convo,
        max_tokens: maxTokens,
        temperature: 0.3,
        tools: [WEB_SEARCH_TOOL],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('[deepseek] API error:', res.status, err);
      return null;
    }

    const data = await res.json();
    const msg = data.choices?.[0]?.message;

    if (!msg) return null;

    // Model wants to search the web — execute and continue the conversation
    if (msg.tool_calls?.length) {
      convo = [...convo, { role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls }];
      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) { /* keep {} */ }
        let result;
        if (tc.function.name === 'web_search') {
          result = await webSearch(args.query || '');
        } else {
          result = { error: `unknown tool: ${tc.function.name}` };
        }
        convo = [...convo, { role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(result) }];
      }
      continue; // let the model finish with the search results
    }

    return msg.content || null;
  }

  // Rounds exhausted (model kept searching) — force a final answer without tools
  console.log('[deepseek] Tool round limit reached, forcing final answer without tools');
  const finalRes = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [...convo, { role: 'user', content: '停止搜索。请立即基于已获得的信息输出最终JSON，个别未核实的信息按最可能结果填写。' }],
      max_tokens: maxTokens,
      temperature: 0.3,
      // no tools — model must answer now
    }),
  });
  if (!finalRes.ok) {
    console.error('[deepseek] Final forced call failed:', finalRes.status, await finalRes.text());
    return null;
  }
  const finalData = await finalRes.json();
  return finalData.choices?.[0]?.message?.content || null;
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

  // News list (take top 20, with URLs and summaries)
  const topNews = (newsItems || []).slice(0, 20);
  let newsList = '';
  topNews.forEach((n, i) => {
    newsList += `${i + 1}. [${n.source}] ${n.title}\n`;
    if (n.summary) newsList += `   摘要: ${n.summary.slice(0, 200)}\n`;
    if (n.url) newsList += `   链接: ${n.url}\n`;
  });

  const today = new Date().toISOString().slice(0, 10);

  return `你是一位资深证券市场分析师，擅长分析重大新闻对资本市场的传导逻辑。请基于今日重大新闻，深入分析对A股、港股、美股市场的潜在影响。

【今日市场行情】
${marketSummary || '暂无数据'}

【今日重大新闻】
${newsList || '暂无新闻'}

【分析要求】
请对每条新闻逐条分析，输出JSON格式。你不仅要做表面分析，更要挖掘背后逻辑链——一篇关于AI的新闻如何影响芯片需求，一条国际关系新闻如何改变大宗商品价格，一条政策新闻如何传导到具体公司业绩。

【联网搜索】
你可以调用 web_search 工具联网获取信息。请在以下情况主动搜索：核实公司股票代码是否真实、核实基金代码是否存在、补充新闻事件的背景与后续进展。每条新闻最多搜索1次，优先保证分析覆盖面，不要过度搜索。

每个字段的要求：
1. news_title: 新闻标题（保持原样）
2. news_summary: 用1-2句话提炼新闻核心要点
3. affected_industries: 具体受影响的行业（如"半导体""新能源""消费电子""房地产""创新药"等），行业名称要具体
4. affected_companies: 可能受影响的上市公司名称和代码（如"宁德时代(300750)"），写出A股/港股/美股的具体公司，至少有具体公司才写
5. funds: 在支付宝(蚂蚁财富)上可以买到的相关基金代码和名称（如"005827 易方达蓝筹精选""001632 天弘中证500"），必须是真实存在的6位基金代码，选2-3只最相关的
6. direction: "利好" / "利空" / "中性"
7. impact_level: 影响强度，"强" / "中" / "弱"
8. chain: 详细分析逻辑传导链条——从新闻事件→行业影响→公司业绩→股价表现，层层递进，150字以上
9. suggestion: 具体的投资建议，包括短期(1-2周)和中期(1-3个月)两个时间维度，80字以上

【输出格式】
严格按以下JSON数组格式输出，不要加任何markdown代码块标记：

[
  {
    "news_title": "新闻标题",
    "news_summary": "1-2句话核心要点提炼",
    "affected_industries": ["行业A", "行业B"],
    "affected_companies": ["公司名(代码)"],
    "funds": ["代码 基金名称", "代码 基金名称"],
    "direction": "利好",
    "impact_level": "强",
    "chain": "详细传导逻辑分析，150字以上...",
    "suggestion": "短期: ...\\n中期: ..."
  }
]

只输出JSON数组，不要加任何markdown代码块标记。funds字段必须写真实存在的6位基金代码。`;
}

// --- Generate analysis via DeepSeek ---
// Parse JSON (array or object) from model output; salvage complete parts if truncated by max_tokens
function parseJsonResponse(response, kind = 'array', tag = 'analyze') {
  if (!response) return null;
  const re = kind === 'array' ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const jsonMatch = response.match(re);
  const text = jsonMatch ? jsonMatch[0] : response;
  try {
    return JSON.parse(text);
  } catch (e) {
    // Truncated mid-string/object: keep content up to the last closing brace
    const lastBrace = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (lastBrace === -1) return null;
    let repaired = text.slice(0, lastBrace + 1).replace(/,\s*$/, '');
    const balance = (o, c) => {
      const open = (repaired.split(o).length - 1);
      const close = (repaired.split(c).length - 1);
      repaired += c.repeat(Math.max(0, open - close));
    };
    balance('[', ']');
    balance('{', '}');
    try {
      const parsed = JSON.parse(repaired);
      console.log(`[${tag}] Salvaged truncated response`);
      return parsed;
    } catch (e2) {
      console.error(`[${tag}] Failed to parse response:`, e.message);
      return null;
    }
  }
}

async function analyzeNews(marketData, newsData) {
  if (!newsData?.items?.length) {
    console.log('[analyze] No news to analyze');
    return [];
  }

  if (!DEEPSEEK_API_KEY) {
    console.log('[analyze] No DeepSeek API key, using rule-based fallback');
    return fallbackAnalysis(marketData, newsData.items);
  }

  // Analyze in small batches so each response stays well under max_tokens
  const items = newsData.items.slice(0, 20);
  const CHUNK_SIZE = 5;
  const analyses = [];

  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    const prompt = buildAnalysisPrompt(marketData, chunk);
    console.log(`[analyze] Sending items ${i + 1}-${i + chunk.length} of ${items.length} to DeepSeek...`);

    const response = await callDeepSeek([
      { role: 'system', content: '你是一位专业证券市场分析师。可以调用 web_search 工具联网核实信息。最终只输出JSON数组,不加markdown代码块标记。' },
      { role: 'user', content: prompt },
    ]);

    const parsed = parseJsonResponse(response, 'array', 'analyze');
    if (parsed?.length) {
      analyses.push(...parsed);
    } else {
      console.log(`[analyze] Chunk ${Math.floor(i / CHUNK_SIZE) + 1} failed, skipping`);
    }
  }

  if (!analyses.length) {
    console.log('[analyze] All DeepSeek calls failed, using fallback');
    return fallbackAnalysis(marketData, newsData.items);
  }

  console.log(`[analyze] DeepSeek returned ${analyses.length} analyses`);
  return analyses;
}

// --- Rule-based fallback (when API key not available) ---
const { analyzeNews: keywordAnalyze } = require('./modules/fetchers/sentiment');

// Fund code database for common industries (fallback mode)
const FUND_DB = {
  '半导体': ['007301 国联安中证全指半导体ETF联接', '008888 华夏国证半导体芯片ETF联接'],
  '新能源': ['001298 华夏新能源车龙头', '005827 易方达蓝筹精选'],
  '人工智能': ['012349 天弘中证人工智能主题', '008087 华夏中证人工智能主题ETF联接'],
  '消费电子': ['008888 华夏国证半导体芯片ETF联接', '001475 易方达消费行业'],
  '医药': ['006002 工银瑞信医药健康', '000913 农银医疗保健'],
  '消费': ['001475 易方达消费行业', '002001 华夏回报'],
  '金融': ['001553 天弘中证银行指数', '160631 鹏华中证银行'],
  '军工': ['001475 富国中证军工', '161024 富国中证军工指数'],
  '互联网': ['164906 交银中证海外中国互联网', '513050 易方达中证海外互联ETF联接'],
};

function fallbackAnalysis(marketData, newsItems) {
  return newsItems.slice(0, 15).map((item) => {
    const sentiment = keywordAnalyze(item);
    const direction = sentiment.label === 'bullish' ? '利好' : sentiment.label === 'bearish' ? '利空' : '中性';

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

    // Match funds from database
    const funds = [];
    for (const ind of industries) {
      if (FUND_DB[ind]) funds.push(...FUND_DB[ind]);
    }

    const summary = item.summary || item.title;
    const indText = industries.length > 0 ? industries.join('、') : '相关板块';

    return {
      news_title: item.title,
      news_summary: summary.slice(0, 150),
      affected_industries: industries.length > 0 ? [...new Set(industries)].slice(0, 3) : ['需进一步分析'],
      affected_companies: ['待AI启用后自动分析'],
      funds: [...new Set(funds)].slice(0, 3),
      direction,
      impact_level: sentiment.label === 'neutral' ? '弱' : '中',
      chain: `该新闻涉及${indText}。${direction === '利好' ? '从基本面来看，该消息可能改善行业供需格局，提升市场风险偏好，短期内资金有望流入相关板块。投资者需关注后续政策细则及行业数据验证。' : direction === '利空' ? '该消息可能加剧市场不确定性，短期内相关板块承压。但需区分是情绪面冲击还是基本面改变——如果是前者，急跌后可能出现超跌反弹机会。' : '该消息对市场影响有限，或方向不明确。建议等待更多信号确认后再做判断，当前阶段以观望为主。'}`,
      suggestion: direction === '利好'
        ? '短期: 关注板块龙头及活跃标的，回调可适当参与。\n中期: 若行业景气度持续验证，可逐步加仓至标配以上。'
        : direction === '利空'
        ? '短期: 建议减仓回避，不急于抄底。\n中期: 观察影响是否被市场消化，待企稳后再评估入场时机。'
        : '短期: 观望为主，控制仓位。\n中期: 等待确定性信号出现后再做配置。',
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

function buildAnalysisCards(analyses, newsData) {
  if (!analyses?.length) return '<p>暂无分析结果</p>';

  // Build a lookup from news title to original news item (for URL)
  const newsLookup = {};
  for (const n of (newsData?.items || [])) {
    newsLookup[n.title] = n;
  }

  let html = '';
  const summaryMap = {};

  for (const a of analyses) {
    const dirClass = a.direction === '利好' ? 'bullish' : a.direction === '利空' ? 'bearish' : 'neutral';
    const dirEmoji = a.direction === '利好' ? '📈' : a.direction === '利空' ? '📉' : '➖';
    const impactBadge = a.impact_level === '强' ? '<span class="badge badge-strong">强影响</span>' :
      a.impact_level === '中' ? '<span class="badge badge-mid">中影响</span>' :
      '<span class="badge badge-weak">弱影响</span>';

    // Find original news URL
    const origNews = newsLookup[a.news_title];
    const newsLink = origNews?.url || '#';
    const newsSource = origNews?.source || '';

    // Fund buttons
    let fundsHtml = '';
    if (a.funds?.length) {
      fundsHtml = '<div class="card-funds"><strong>相关基金(支付宝可买):</strong><div class="fund-list">';
      for (const f of a.funds) {
        const code = f.match(/\d{6}/)?.[0] || '';
        const name = f.replace(code, '').trim();
        fundsHtml += `<a class="fund-tag" href="https://fund.eastmoney.com/${code}.html" target="_blank" title="查看基金详情">${code} ${name}</a>`;
      }
      fundsHtml += '</div></div>';
    }

    // Split suggestion into short/mid term
    let suggestionHtml = '';
    const sugText = a.suggestion || '';
    if (sugText.includes('短期') && sugText.includes('中期')) {
      suggestionHtml = `<div class="card-row suggestion">💡 ${sugText.replace(/\n/g, '<br>')}</div>`;
    } else {
      suggestionHtml = `<div class="card-row suggestion">💡 ${sugText}</div>`;
    }

    html += `<div class="card ${dirClass}">
      <div class="card-header">
        <span class="card-dir">${dirEmoji} ${a.direction}</span>
        ${impactBadge}
        <a class="card-news-link" href="${newsLink}" target="_blank" title="查看原文">${a.news_title}</a>
        ${newsSource ? `<span class="card-source">${newsSource}</span>` : ''}
      </div>
      ${a.news_summary ? `<div class="card-summary">📰 ${a.news_summary}</div>` : ''}
      <div class="card-body">
        <div class="card-row"><strong>影响行业:</strong> ${(a.affected_industries || []).join('、') || '待分析'}</div>
        <div class="card-row"><strong>相关公司:</strong> ${(a.affected_companies || []).join('、') || '待分析'}</div>
        ${fundsHtml}
        <div class="card-row chain">🔗 <strong>传导逻辑:</strong><br>${a.chain || a.analysis || ''}</div>
        ${suggestionHtml}
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

// --- Investment forecasts (tomorrow / 1 month / 6 months) ---
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1 + n, 1);
  const lastDay = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
  dt.setDate(Math.min(d, lastDay));
  const p = (x) => String(x).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

function buildForecastPrompt(marketData, analyses, dateStr) {
  let marketSummary = '';
  for (const idx of [...(marketData.aShares || []), ...(marketData.usShares || [])]) {
    const sign = idx.changePercent > 0 ? '+' : '';
    marketSummary += `- ${idx.name}: ${idx.price?.toFixed(2)} (${sign}${idx.changePercent?.toFixed(2)}%)\n`;
  }

  const digest = (analyses || []).slice(0, 15).map((a, i) =>
    `${i + 1}. [${a.direction || '中性'}/${a.impact_level || '?'}影响] ${a.news_title}\n   行业: ${(a.affected_industries || []).join('、') || '-'}`
  ).join('\n');

  const tomorrow = addDays(dateStr, 1);

  return `你是一位资深证券投资策略分析师。今天是 ${dateStr}，A股已收盘（本报告18:00后生成）。请基于今日行情与逐条新闻分析，给出三个时间维度的投资预测。

【今日行情】
${marketSummary || '暂无数据'}

【今日新闻与分析结论】
${digest || '暂无'}

【预测要求】
输出三个时间维度，结构完全相同：
- tomorrow: 明日预测（下一交易日 ${tomorrow}）
- oneMonth: 一月后预测
- halfYear: 半年后预测

每个维度必须包含：
1. view: 对大盘的1-2句话总体判断
2. bullish: 利好方向 1-3 项，每项字段：
   - industry: 受益行业（具体，如"半导体""创新药"）
   - action: 固定为 "加仓"
   - reason: 利好逻辑（40字内）
   - funds: 2-3只代表基金，格式 "6位代码 基金全名"（如 "008887 华夏国证半导体芯片ETF联接A"），必须是真实存在的基金
3. bearish: 利空方向 1-3 项，每项字段：
   - industry: 受损行业
   - action: 按看空程度选 "减仓" 或 "清仓"
   - reason: 利空逻辑（40字内）
   - funds: 相关基金（提示已持有者处理/回避），格式同上

要求：
- 基金代码必须真实，不确定时调用 web_search 核实（如 "XX基金 代码 支付宝"）
- 搜索预算：最多进行2轮联网搜索（可同轮并行多个查询），之后无论核实与否都必须立即输出最终 JSON，未核实的按最可能结果填写
- 明日看情绪与资金面，一月看政策与业绩传导，半年看产业趋势与宏观周期
- 三个维度的判断允许不同甚至相反（如短期避险但长期看好）

【输出格式】严格JSON，不加markdown代码块：
{
  "tomorrow": {
    "view": "大盘判断",
    "bullish": [{"industry": "行业", "action": "加仓", "reason": "逻辑", "funds": ["代码 基金名"]}],
    "bearish": [{"industry": "行业", "action": "减仓", "reason": "逻辑", "funds": ["代码 基金名"]}]
  },
  "oneMonth": { "view": "", "bullish": [], "bearish": [] },
  "halfYear": { "view": "", "bullish": [], "bearish": [] }
}`;
}

async function generateForecasts(marketData, newsData, analyses) {
  if (!DEEPSEEK_API_KEY) {
    console.error('[forecast] No DeepSeek API key, forecasts skipped');
    return null;
  }

  const prompt = buildForecastPrompt(marketData, analyses, new Date().toISOString().slice(0, 10));
  console.log('[forecast] Requesting three-horizon forecasts from DeepSeek...');

  const response = await callDeepSeek([
    { role: 'system', content: '你是资深证券投资策略分析师。可调用 web_search 工具核实基金代码与事实。搜索要克制（最多2轮），之后必须立即输出最终JSON对象,不加markdown代码块标记。' },
    { role: 'user', content: prompt },
  ], 32768, 5);

  const parsed = parseJsonResponse(response, 'object', 'forecast');
  if (!parsed?.tomorrow || !parsed?.oneMonth || !parsed?.halfYear) {
    console.error('[forecast] Invalid forecast response, section will show failure notice');
    return null;
  }

  console.log('[forecast] OK: tomorrow/oneMonth/halfYear generated');
  return parsed;
}

function buildForecastHtml(forecasts, dateStr) {
  const title = '<div class="section-title">AI 投资预测</div>';

  if (!forecasts) {
    return title + '<div class="forecast-box fc-error">⚠ 预测生成失败：本期未能获得 AI 预测输出（API 异常或响应解析失败）。逐条分析不受影响，详情见生成日志。</div>';
  }

  const periods = [
    ['tomorrow', '📅 明日预测', addDays(dateStr, 1)],
    ['oneMonth', '📅 一月后预测', addMonths(dateStr, 1)],
    ['halfYear', '📅 半年后预测', addMonths(dateStr, 6)],
  ];

  let body = '';
  for (const [key, label, date] of periods) {
    const p = forecasts[key];
    if (!p) {
      body += `<div class="fc-period"><div class="fc-title">${label}（${date}）</div><div class="fc-view">无预测数据</div></div>`;
      continue;
    }

    let sides = '';
    for (const [side, list, tag] of [
      ['bull', p.bullish, '📈 利好 · 加仓方向'],
      ['bear', p.bearish, '📉 利空 · 减仓/清仓方向'],
    ]) {
      if (!Array.isArray(list) || !list.length) continue;
      let items = '';
      for (const it of list) {
        const funds = (it.funds || []).map((f) => `<span class="fund-tag">${esc(f)}</span>`).join('');
        items += `<div class="fc-item">
          <span class="fc-ind">${esc(it.industry)}</span>${it.action ? `<span class="fc-act">${esc(it.action)}</span>` : ''}
          ${it.reason ? `<div class="fc-reason">${esc(it.reason)}</div>` : ''}
          ${funds ? `<div class="fund-list">${funds}</div>` : ''}
        </div>`;
      }
      sides += `<div class="fc-side ${side}"><span class="fc-tag">${tag}</span>${items}</div>`;
    }

    body += `<div class="fc-period">
      <div class="fc-title">${label}（${date}）</div>
      ${p.view ? `<div class="fc-view">${esc(p.view)}</div>` : ''}
      ${sides}
    </div>`;
  }

  return title + `<div class="forecast-box">${body}
    <div class="fc-disclaimer">⚠ 预测由 AI 生成，仅供参考，不构成投资建议。基金代码来自公开信息，投资前请自行核实。</div>
  </div>`;
}

async function generateHtml(marketData, analyses, newsData, dateStr, forecasts) {
  const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
  const dayOfWeek = dayNames[new Date(dateStr).getDay()];
  const { cardsHtml, summaryMap } = buildAnalysisCards(analyses, newsData);
  const summaryHtml = buildSummaryBox(summaryMap);
  const forecastHtml = buildForecastHtml(forecasts, dateStr);

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
.forecast-box{background:#1a1a2e;border-radius:10px;padding:16px;margin-bottom:20px;border:1px solid #2a2a3e}
.forecast-box.fc-error{border-color:#e15241;color:#e15241;font-size:13px}
.fc-period{margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid #2a2a3e}
.fc-period:last-of-type{border-bottom:none;margin-bottom:0;padding-bottom:0}
.fc-title{font-size:14px;font-weight:700;color:#f0f0f0;margin-bottom:4px}
.fc-view{font-size:12px;color:#999;margin-bottom:8px;line-height:1.6}
.fc-side{margin-top:8px;padding:8px 10px;border-radius:6px;font-size:13px}
.fc-side.bull{background:rgba(225,82,65,.06);border-left:3px solid #e15241}
.fc-side.bear{background:rgba(26,173,25,.06);border-left:3px solid #1aad19}
.fc-tag{font-weight:700;font-size:12px}
.fc-side.bull .fc-tag{color:#e15241}
.fc-side.bear .fc-tag{color:#1aad19}
.fc-item{margin-top:8px;line-height:1.6}
.fc-ind{font-weight:600;color:#f0f0f0}
.fc-act{font-size:11px;padding:1px 8px;border-radius:8px;margin-left:6px;background:rgba(255,193,7,.15);color:#ffc107;font-weight:600}
.fc-reason{color:#999;font-size:12px;margin-top:2px}
.fc-disclaimer{margin-top:12px;padding-top:10px;border-top:1px solid #2a2a3e;font-size:11px;color:#666;line-height:1.6}
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
.card-news-link{color:#e0e0e0;text-decoration:none;font-size:13px;flex:1;line-height:1.4}
.card-news-link:hover{color:#e15241;text-decoration:underline}
.card-source{font-size:10px;color:#666;background:rgba(255,255,255,.05);padding:1px 6px;border-radius:3px;flex-shrink:0}
.card-summary{font-size:12px;color:#888;margin-bottom:8px;padding:6px 10px;background:rgba(255,255,255,.02);border-radius:4px;line-height:1.5}
.card-row.chain{color:#bbb;margin-top:8px;padding:10px;background:rgba(225,82,65,.05);border-radius:6px;line-height:1.7;font-size:13px}
.card-row.suggestion{color:#e15241;margin-top:8px;font-weight:500;line-height:1.6}
.card-funds{margin-top:6px}
.card-funds strong{font-size:12px;color:#aaa}
.fund-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.fund-tag{display:inline-block;padding:5px 10px;background:rgba(225,82,65,.1);color:#e15241;border-radius:6px;font-size:12px;text-decoration:none;border:1px solid rgba(225,82,65,.2);transition:all .2s}
.fund-tag:hover{background:rgba(225,82,65,.2);border-color:#e15241}
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

  ${forecastHtml}

  ${summaryHtml}

  <div class="section-title">AI 逐条分析</div>
  ${cardsHtml}

  <div class="footer">
    <p>AI 投资分析日报 &middot; 每日 18:00 自动生成</p>
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

  // AI Forecasts (tomorrow / 1 month / 6 months)
  let forecasts = null;
  try {
    forecasts = await generateForecasts(marketData, newsData, analyses);
  } catch (err) {
    console.error('[forecast] Error:', err.message);
  }
  if (!forecasts) {
    console.error('[generate] ⚠ Forecast generation failed — page will show an explicit failure notice');
  }

  // Generate HTML
  console.log('[generate] Generating HTML...');
  const html = await generateHtml(marketData, analyses, newsData, todayStr, forecasts);

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
  fs.writeFileSync(jsonPath, JSON.stringify({ date: todayStr, marketData, newsData, analyses, forecasts }, null, 2));
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
