// Optional LLM news layer: when ANTHROPIC_API_KEY is set, headlines are sent
// to the Claude API for a structured read — summary, market-impact call,
// event extraction (central-bank surprises, geopolitical escalation, ...)
// and per-bucket sentiment that augments the wordlist scorer. Without a key
// everything falls back to the transparent wordlist sentiment.
//
// Raw fetch (no SDK) keeps the project zero-dependency. Override the model
// with LLM_MODEL (e.g. claude-haiku-4-5 to cut cost ~5x).

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.LLM_MODEL || 'claude-opus-4-8';

// Bucket keys the engine understands (TAG_RULES vocabulary + engine keys the
// wordlist tagger can't reach, like individual sectors/styles).
const BUCKETS = [
  'us', 'europe', 'uk', 'japan', 'china', 'india', 'em', 'latam', 'canada', 'austr',
  'tech', 'financials', 'health', 'energy', 'industrials', 'discretionary',
  'staples', 'utilities', 'materials', 'realestate', 'comms',
  'value', 'growth', 'quality', 'smallcap',
  'gold', 'oil', 'tips', 'rates', 'global'
];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'marketImpact', 'events', 'bucketSentiment'],
  properties: {
    summary: { type: 'string', description: '2-3 sentence synthesis of what the headlines mean for global markets' },
    marketImpact: { type: 'string', enum: ['risk_on', 'risk_off', 'mixed', 'neutral'] },
    events: {
      type: 'array',
      description: 'Up to 8 market-moving events found in the headlines, most significant first',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['headline', 'type', 'severity', 'buckets', 'direction'],
        properties: {
          headline: { type: 'string', description: 'Short restatement of the event' },
          type: { type: 'string', enum: ['central_bank', 'geopolitical', 'inflation', 'growth', 'earnings', 'energy', 'fiscal', 'other'] },
          severity: { type: 'integer', enum: [1, 2, 3], description: '1 = noteworthy, 3 = regime-relevant' },
          buckets: { type: 'array', items: { type: 'string', enum: BUCKETS } },
          direction: { type: 'integer', enum: [-1, 1], description: '+1 supportive / -1 negative for the tagged buckets' }
        }
      }
    },
    bucketSentiment: {
      type: 'array',
      description: 'Net sentiment per affected bucket, -1 (very negative) to +1 (very positive). Only include buckets the headlines actually speak to.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['bucket', 'sentiment'],
        properties: {
          bucket: { type: 'string', enum: BUCKETS },
          sentiment: { type: 'number' }
        }
      }
    }
  }
};

const SYSTEM = `You are the news-analysis layer of a global market dashboard for a passive MSCI ACWI investor.
You receive recent headlines from general/financial news feeds. Assess only what is market-relevant.
Be conservative: most headlines do not move markets; reserve severity 3 for genuine regime-relevant events
(central-bank surprises, major geopolitical escalation, systemic credit events). Sentiment values are small
nudges to an allocation engine, never a driver, so avoid extremes unless clearly warranted.`;

const clamp = (x) => Math.max(-1, Math.min(1, x));

export async function enrichNews(items) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !items?.length) return null;

  const headlines = items
    .slice(0, 40)
    .map((n, i) => `${i + 1}. [${n.source}] ${n.title}`)
    .join('\n');

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 3000,
        system: SYSTEM,
        messages: [{ role: 'user', content: `Headlines from the last few hours:\n\n${headlines}` }],
        output_config: { format: { type: 'json_schema', schema: SCHEMA } }
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data.content?.find((b) => b.type === 'text')?.text;
    if (!text) throw new Error('no text block in response');
    const parsed = JSON.parse(text);

    const byBucket = {};
    for (const e of parsed.bucketSentiment || []) {
      if (BUCKETS.includes(e.bucket) && Number.isFinite(e.sentiment)) {
        byBucket[e.bucket] = +clamp(e.sentiment).toFixed(2);
      }
    }
    return {
      model: MODEL,
      at: Date.now(),
      summary: String(parsed.summary || '').slice(0, 600),
      marketImpact: parsed.marketImpact || 'neutral',
      events: (parsed.events || []).slice(0, 8),
      byBucket
    };
  } catch (err) {
    console.warn(`[llm] news enrichment failed: ${err.message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Average LLM bucket sentiment with the wordlist scores where both exist;
// LLM fills buckets the wordlist tagger can't reach.
export function blendSentiment(agg, llm) {
  if (!llm?.byBucket || !Object.keys(llm.byBucket).length) return agg;
  const byTag = { ...agg.byTag };
  for (const [k, v] of Object.entries(llm.byBucket)) {
    byTag[k] = byTag[k] != null ? +(((byTag[k] + v) / 2)).toFixed(3) : v;
  }
  return { ...agg, byTag, llmBlended: true };
}
