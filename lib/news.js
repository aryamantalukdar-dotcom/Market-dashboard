// RSS news ingestion with lightweight keyword sentiment and bucket tagging.
// Sentiment here is intentionally simple and transparent (wordlist-based);
// it only nudges the engine (10% weight), it never drives a tilt on its own.

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (market-dashboard RSS reader)' };

const POSITIVE = [
  'rally', 'rallies', 'surge', 'soar', 'jump', 'gain', 'gains', 'beat', 'beats',
  'record high', 'optimism', 'recovery', 'rebound', 'upgrade', 'deal', 'agreement',
  'cools', 'easing', 'rate cut', 'cuts rates', 'stimulus', 'breakthrough', 'boom',
  'strong growth', 'expands', 'tops estimates', 'truce', 'ceasefire'
];

const NEGATIVE = [
  'crash', 'plunge', 'plummet', 'tumble', 'slump', 'sink', 'fear', 'recession',
  'war', 'sanction', 'default', 'crisis', 'layoff', 'miss', 'downgrade', 'hike',
  'escalat', 'attack', 'strike', 'tariff', 'shutdown', 'selloff', 'sell-off',
  'bankrupt', 'contagion', 'slowdown', 'warning', 'collapse', 'turmoil', 'inflation jumps',
  'invasion', 'conflict', 'bond rout', 'stagflation'
];

// Maps keyword regexes to engine bucket keys (regions/sectors/asset classes).
const TAG_RULES = [
  [/\b(fed|fomc|powell|federal reserve|treasur(y|ies)|wall street|s&p|nasdaq|dow)\b/i, ['us', 'rates']],
  [/\b(china|beijing|yuan|shanghai|hong kong)\b/i, ['china', 'em']],
  [/\b(ecb|eurozone|euro area|europe|germany|france|brussels|eu)\b/i, ['europe']],
  [/\b(japan|boj|yen|tokyo|nikkei)\b/i, ['japan']],
  [/\b(uk|britain|british|bank of england|ftse|london)\b/i, ['uk']],
  [/\b(india|rupee|mumbai|rbi)\b/i, ['india']],
  [/\b(brazil|mexico|latin america|argentina)\b/i, ['latam', 'em']],
  [/\b(emerging market)/i, ['em']],
  [/\b(oil|opec|crude|brent|petroleum)\b/i, ['energy', 'oil']],
  [/\b(gold|bullion)\b/i, ['gold']],
  [/\b(ai|artificial intelligence|chip|semiconductor|tech|software)\b/i, ['tech']],
  [/\b(bank|banks|banking|credit|lender)\b/i, ['financials']],
  [/\b(housing|real estate|property)\b/i, ['realestate']],
  [/\b(pharma|drug|health|vaccine)\b/i, ['health']],
  [/\b(retail|consumer spending)\b/i, ['discretionary']],
  [/\b(inflation|cpi|prices rise)\b/i, ['rates', 'tips']],
  [/\b(bond|yield|rates?)\b/i, ['rates']],
  [/\b(tariff|trade war|geopolit|nato|middle east|ukraine|taiwan)\b/i, ['global']]
];

// Personal-finance advice columns and lifestyle noise that general feeds mix
// in with market news ("Do we fire our adviser?", "I'm 65 with $2 million...").
// Matched against the headline only; deliberately targeted so geopolitics and
// market op-eds survive.
const NOISE_PATTERNS = [
  /\b(the moneyist|dear abby|dear quentin|help me retire|fix my portfolio|big move|quentin fottrell)\b/i,
  // Quoted first-person lead-in followed by a colon — the classic advice-
  // column format ("'I feel like...': Our adviser..."). Kept narrow so
  // quoted-official headlines ("'I will act': Fed chair...") survive via the
  // length requirement plus first-person continuation.
  /^[‘'"“]I (feel|think|am|was|have|just|don'?t|can'?t|never|recently)\b[^:]{5,90}[’'"”]:/i,
  /\b(my|our|his|her) (husband|wife|mother|father|mom|dad|son|daughter|brother|sister|in-laws?|boyfriend|girlfriend|fianc\w*|grandmother|grandfather|stepmother|stepfather|family)\b/i,
  /\b(my|our) (financial )?(adviser|advisor|planner|broker)\b/i,
  /\b(do|should|can|am|are) (i|we)\b.{0,80}\?/i,
  /\bi['’]?m \d{2}\b/i,
  /\b(horoscope|powerball|mega millions|lottery numbers?)\b/i,
  /\bbest (credit cards?|savings accounts?|cd rates|mortgage lenders)\b/i
];

export function isNoiseHeadline(title) {
  return NOISE_PATTERNS.some((re) => re.test(title));
}

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/<[^>]+>/g, '')
    .trim();
}

function extract(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

export function parseRss(xml, sourceName) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const block of blocks.slice(0, 25)) {
    const title = extract(block, 'title');
    if (!title) continue;
    const link = extract(block, 'link') || (block.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? '');
    const pubDate = extract(block, 'pubDate') || extract(block, 'dc:date');
    const description = extract(block, 'description').slice(0, 280);
    items.push({ title, link, description, source: sourceName, publishedAt: pubDate ? Date.parse(pubDate) || null : null });
  }
  return items;
}

export function scoreSentiment(text) {
  const lower = text.toLowerCase();
  let score = 0;
  for (const w of POSITIVE) if (lower.includes(w)) score += 1;
  for (const w of NEGATIVE) if (lower.includes(w)) score -= 1;
  return Math.max(-2, Math.min(2, score));
}

export function tagItem(text) {
  const tags = new Set();
  for (const [re, keys] of TAG_RULES) if (re.test(text)) keys.forEach((k) => tags.add(k));
  return [...tags];
}

export async function fetchNews(feeds) {
  const all = [];
  const errors = new Map();
  await Promise.all(feeds.map(async (feed) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(feed.url, { headers: HEADERS, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      all.push(...parseRss(xml, feed.name));
    } catch (err) {
      errors.set(feed.name, String(err.message || err));
    } finally {
      clearTimeout(t);
    }
  }));

  const items = all
    .filter((item) => !isNoiseHeadline(item.title))
    .map((item) => {
      const text = `${item.title} ${item.description}`;
      return { ...item, sentiment: scoreSentiment(text), tags: tagItem(text) };
    })
    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
    .slice(0, 60);

  return { items, errors };
}

// Average sentiment per bucket tag, used as a small engine nudge.
export function aggregateSentiment(items) {
  const sums = new Map();
  let global = 0;
  let globalN = 0;
  for (const item of items) {
    if (item.sentiment === 0) continue;
    global += item.sentiment;
    globalN += 1;
    for (const tag of item.tags) {
      const cur = sums.get(tag) || { sum: 0, n: 0 };
      cur.sum += item.sentiment;
      cur.n += 1;
      sums.set(tag, cur);
    }
  }
  const byTag = {};
  for (const [tag, { sum, n }] of sums) byTag[tag] = sum / n / 2; // normalize to roughly [-1, 1]
  return { byTag, overall: globalN ? global / globalN / 2 : 0 };
}
