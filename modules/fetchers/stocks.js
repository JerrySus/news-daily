const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// Sina Finance API
// A-share format: sh000001, sz399001, etc.
// US/International format: gb_$dji, gb_$ixic, gb_$inx
const SINA_A_CODES = 'sh000001,sz399001,sz399006,sh000300,sh000688';
const SINA_US_CODES = 'gb_$dji,gb_$ixic,gb_$inx';

const INDEX_NAMES = {
  sh000001: { name: '上证指数', code: '000001' },
  sz399001: { name: '深证成指', code: '399001' },
  sz399006: { name: '创业板指', code: '399006' },
  sh000300: { name: '沪深300', code: '000300' },
  sh000688: { name: '科创50', code: '000688' },
  'gb_$dji': { name: '道琼斯', code: 'DJI' },
  'gb_$ixic': { name: '纳斯达克', code: 'IXIC' },
  'gb_$inx': { name: '标普500', code: 'SPX' },
};

function parseSinaResponse(text) {
  const results = [];
  const lines = text.split('\n');
  for (const line of lines) {
    // Match both formats: hq_str_CODE="..." (A-shares) and hq_str_gb_$CODE="..." (international)
    const match = line.match(/hq_str_([^=]+)="(.+)"/);
    if (!match) continue;
    const rawCode = match[1];
    const fields = match[2].split(',');
    if (fields.length < 5) continue;

    // Find matching info by checking all keys
    let info = INDEX_NAMES[rawCode];
    if (!info) continue;

    // Detect format: A-share (sh/sz prefix) vs international (gb_ prefix)
    if (rawCode.startsWith('sh') || rawCode.startsWith('sz')) {
      // A-share format: name, open, prevClose, price, high, low, ...
      const price = parseFloat(fields[3]) || null;
      const prevClose = parseFloat(fields[2]) || null;
      const open = parseFloat(fields[1]) || null;
      const high = parseFloat(fields[4]) || null;
      const low = parseFloat(fields[5]) || null;
      const change = price && prevClose ? +(price - prevClose).toFixed(2) : null;
      const changePercent = price && prevClose ? +(((price - prevClose) / prevClose) * 100).toFixed(2) : null;

      results.push({
        name: info.name,
        code: info.code,
        price,
        change,
        changePercent,
        high,
        low,
        open,
        prevClose,
      });
    } else {
      // International format (gb_): name, price, changePct, time, changeAmt, ...
      // field[1]=price, field[2]=changePct, field[4]=changeAmt
      const price = parseFloat(fields[1]) || null;
      const changePercent = parseFloat(fields[2]) || null;
      const change = parseFloat(fields[4]) || null;

      // Find prevClose - it's usually field[26] based on observed data
      const prevClose = parseFloat(fields[26]) || null;
      const high = parseFloat(fields[6]) || null;
      const low = parseFloat(fields[7]) || null;

      results.push({
        name: info.name,
        code: info.code,
        price,
        change,
        changePercent,
        high,
        low,
        open: null,
        prevClose,
      });
    }
  }
  return results;
}

async function fetchSinaStocks(codes) {
  const tryFetch = async (url) => {
    const { data } = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': UA, 'Referer': 'https://finance.sina.com.cn/' },
    });
    return parseSinaResponse(typeof data === 'string' ? data : JSON.stringify(data));
  };

  try {
    return await tryFetch(`https://hq.sinajs.cn/list=${codes}`);
  } catch (e) {
    console.error(`Sina https failed:`, e.message);
    try {
      return await tryFetch(`http://hq.sinajs.cn/list=${codes}`);
    } catch (e2) {
      console.error('Sina http also failed:', e2.message);
      return [];
    }
  }
}

// East Money for hot sectors
const SECTOR_URL =
  'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=8&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f2,f3,f4,f12,f14';

async function fetchSectors() {
  try {
    const { data } = await axios.get(SECTOR_URL, {
      timeout: 10000,
      headers: { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' },
    });
    const list = data?.data?.diff || [];
    return list.slice(0, 6).map((item) => ({
      name: item.f14,
      code: item.f12,
      price: item.f2,
      changePercent: item.f3,
      change: item.f4,
    }));
  } catch (e) {
    console.error('Failed to fetch sectors:', e.message);
    return [];
  }
}

async function fetchAllMarketData() {
  const [allStocks, sectors] = await Promise.all([
    // Fetch A-shares and US in parallel, then merge
    (async () => {
      const [aRes, usRes] = await Promise.all([
        fetchSinaStocks(SINA_A_CODES),
        fetchSinaStocks(SINA_US_CODES),
      ]);
      return { aShares: aRes, usShares: usRes };
    })(),
    fetchSectors(),
  ]);

  return {
    aShares: allStocks.aShares,
    usShares: allStocks.usShares,
    sectors: sectors,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { fetchAllMarketData, fetchSinaStocks, fetchSectors };
