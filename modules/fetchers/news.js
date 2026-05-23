const RssParser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');

const parser = new RssParser({ timeout: 10000 });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// East Money fast news API (free, very reliable)
const EASTMONEY_NEWS_URL =
  'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13,f14,f17&secids=1.000001,0.399001,0.399006,1.000300&np=1&pn=1&pz=10&po=1&ut=bd1d9ddb04089700cf9c27f6f7426281';

async function fetchSinaFinanceNews() {
  try {
    const { data } = await axios.get('https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2512&k=&num=20&page=1', {
      timeout: 10000,
      headers: { 'User-Agent': UA, 'Referer': 'https://finance.sina.com.cn/' },
    });
    const list = data?.result?.data || [];
    return list.map((item) => ({
      title: item.title || '',
      summary: item.intro || '',
      source: '新浪财经',
      url: item.url || '',
      time: new Date(item.ctime * 1000 || Date.now()).toISOString(),
      category: 'finance',
    }));
  } catch (e) {
    console.error('Failed to fetch Sina news:', e.message);
    return [];
  }
}

async function fetchEastMoneyFastNews() {
  try {
    const { data } = await axios.get(EASTMONEY_NEWS_URL, {
      timeout: 10000,
      headers: { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' },
    });
    // This API returns market snapshots, not news. Let me use a proper news API.
    return [];
  } catch (e) {
    return [];
  }
}

async function fetchEastMoneyHeadlines() {
  try {
    const { data } = await axios.get('https://finance.eastmoney.com/', {
      timeout: 15000,
      headers: { 'User-Agent': UA },
    });
    const $ = cheerio.load(data);
    const news = [];
    // Try multiple selectors that East Money uses
    $('a[href]').each((i, el) => {
      const $el = $(el);
      const title = $el.text().trim();
      const href = $el.attr('href');
      // Filter for news links with meaningful titles
      if (title.length > 8 && title.length < 120 && href && (href.includes('/a/') || href.includes('news') || href.includes('article'))) {
        if (!title.includes('广告') && !title.includes('推广') && !title.includes('function')) {
          news.push({
            title,
            summary: '',
            source: '东方财富',
            url: href.startsWith('http') ? href : `https://finance.eastmoney.com${href}`,
            time: new Date().toISOString(),
            category: 'finance',
          });
        }
      }
    });
    return news.slice(0, 15);
  } catch (e) {
    console.error('Failed to fetch East Money:', e.message);
    return [];
  }
}

async function fetchClsNews() {
  try {
    const { data } = await axios.post(
      'https://www.cls.cn/v3/depth/home/assembled/1000',
      { sign: 'home' },
      {
        timeout: 10000,
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
      }
    );
    const articles = data?.data?.roll_data || [];
    return articles.slice(0, 15).map((item) => ({
      title: item.title || item.article_title || '',
      summary: item.brief || '',
      source: '财联社',
      url: `https://www.cls.cn/detail/${item.id}`,
      time: new Date((item.ctime || item.mtime) * 1000 || Date.now()).toISOString(),
      category: 'finance',
    }));
  } catch (e) {
    console.error('Failed to fetch CLS news:', e.message);
    return [];
  }
}

async function fetchRssSource(source) {
  try {
    const feed = await parser.parseURL(source.url);
    return (feed.items || []).slice(0, 8).map((item) => ({
      title: item.title || '',
      summary: (item.contentSnippet || '').slice(0, 200),
      source: source.name,
      url: item.link || '',
      time: new Date(item.pubDate || Date.now()).toISOString(),
      category: 'general',
    }));
  } catch (e) {
    console.error(`Failed to fetch ${source.name}:`, e.message);
    return [];
  }
}

const RSS_SOURCES = [
  // These may be slow/blocked from China, so we use short timeouts
  { url: 'https://feeds.bbci.co.uk/news/business/rss.xml', name: 'BBC商业' },
];

async function fetchAllNews() {
  const allResults = await Promise.allSettled([
    fetchSinaFinanceNews(),
    fetchClsNews(),
    fetchEastMoneyHeadlines(),
    ...RSS_SOURCES.map(fetchRssSource),
  ]);

  const all = [];
  for (const result of allResults) {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      all.push(...result.value);
    }
  }

  // Deduplicate by title similarity
  const seen = new Set();
  const deduped = all.filter((item) => {
    const key = item.title.slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by time
  deduped.sort((a, b) => {
    return new Date(b.time).getTime() - new Date(a.time).getTime();
  });

  return {
    items: deduped.slice(0, 30),
    count: deduped.length,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { fetchAllNews };
