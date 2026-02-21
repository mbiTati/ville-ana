import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import cheerio from 'cheerio';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

// -------------------------
// Helpers
// -------------------------
function timeout(ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { controller, clear: () => clearTimeout(t) };
}

async function fetchText(url, opts = {}) {
  const { controller, clear } = timeout(opts.timeoutMs ?? 20000);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: {
        'User-Agent': 'SecteurAnalyzer/1.0 (+local dev)',
        'Accept': opts.accept ?? 'text/html,application/json;q=0.9,*/*;q=0.8',
        ...(opts.headers || {})
      }
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, headers: res.headers };
  } finally {
    clear();
  }
}

async function fetchJson(url, opts = {}) {
  const { controller, clear } = timeout(opts.timeoutMs ?? 20000);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: {
        'User-Agent': 'SecteurAnalyzer/1.0 (+local dev)',
        'Accept': 'application/json',
        ...(opts.headers || {})
      }
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } finally {
    clear();
  }
}

function normalizeNumber(str) {
  if (!str) return null;
  const s = String(str)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // keep digits, comma, dot
  const m = s.match(/-?[0-9][0-9\s]*([\.,][0-9]+)?/);
  if (!m) return null;
  const n = m[0].replace(/\s/g, '').replace(',', '.');
  const val = Number(n);
  return Number.isFinite(val) ? val : null;
}

function googleMairieQuery(nom, cp) {
  const q = `${nom} ${cp ? cp + ' ' : ''}site:fr mairie`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

// -------------------------
// Static front
// -------------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.updated.html'));
});

app.get('/app.updated.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.updated.js'));
});

// -------------------------
// Proxy Geo API (avoids CORS + allows running from localhost)
// -------------------------
app.get('/api/geo/communes', async (req, res) => {
  const url = new URL('https://geo.api.gouv.fr/communes');
  for (const [k, v] of Object.entries(req.query)) {
    url.searchParams.set(k, String(v));
  }
  const out = await fetchJson(url.toString(), { timeoutMs: 15000 });
  res.status(out.status).json(out.data ?? { error: 'geo api error' });
});

app.get('/api/geo/communes/:code', async (req, res) => {
  const url = `https://geo.api.gouv.fr/communes/${encodeURIComponent(req.params.code)}?${new URLSearchParams(req.query).toString()}`;
  const out = await fetchJson(url, { timeoutMs: 15000 });
  res.status(out.status).json(out.data ?? { error: 'geo api error' });
});

// -------------------------
// DVF Etalab (mutations3)
// -------------------------
app.get('/api/dvf/mutations3/:insee', async (req, res) => {
  const insee = req.params.insee;
  const url = `https://app.dvf.etalab.gouv.fr/api/mutations3/${encodeURIComponent(insee)}`;
  const out = await fetchJson(url, { timeoutMs: 25000 });
  res.status(out.status).json(out.data ?? { mutations: [] });
});

// -------------------------
// L'Internaute: logement par type + taille (scrape)
// -------------------------
app.get('/api/linternaute', async (req, res) => {
  const { slug, code_insee } = req.query;
  if (!slug || !code_insee) return res.status(400).json({ error: 'missing slug or code_insee' });

  const url = `https://www.linternaute.com/ville/${encodeURIComponent(slug)}/ville-${encodeURIComponent(code_insee)}/immobilier`;

  const page = await fetchText(url, {
    timeoutMs: 25000,
    headers: {
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.6'
    }
  });

  if (!page.ok) return res.status(502).json({ error: 'linternaute_fetch_failed', status: page.status, url });

  const $ = cheerio.load(page.text);
  const text = $('body').text().replace(/\s+/g, ' ');

  // Generic extraction from visible tables (works even if DOM changes a bit)
  function pick(labelRegex) {
    const r = new RegExp(labelRegex.source + "\\s*([0-9][0-9\u00a0\s]*)\\s*(%|)" , 'i');
    const m = text.match(r);
    if (!m) return null;
    const n = normalizeNumber(m[1]);
    return n;
  }

  // Shares (percent)
  const partRP = (() => {
    const m = text.match(/Résidences principales\s*[0-9\u00a0\s]+\s*([0-9]+[\.,]?[0-9]*)\s*%/i);
    return m ? normalizeNumber(m[1]) : null;
  })();
  const partRS = (() => {
    const m = text.match(/Résidences secondaires\s*[0-9\u00a0\s]+\s*([0-9]+[\.,]?[0-9]*)\s*%/i);
    return m ? normalizeNumber(m[1]) : null;
  })();
  const vacants = (() => {
    const m = text.match(/Logements vacants\s*[0-9\u00a0\s]+\s*([0-9]+[\.,]?[0-9]*)\s*%/i);
    return m ? normalizeNumber(m[1]) : null;
  })();

  // T1..T5+ : some pages show "T5 et plus"
  const t1 = (() => { const m = text.match(/\bT1\b[^%]{0,80}?([0-9]+[\.,]?[0-9]*)\s*%/i); return m ? normalizeNumber(m[1]) : null; })();
  const t2 = (() => { const m = text.match(/\bT2\b[^%]{0,80}?([0-9]+[\.,]?[0-9]*)\s*%/i); return m ? normalizeNumber(m[1]) : null; })();
  const t3 = (() => { const m = text.match(/\bT3\b[^%]{0,80}?([0-9]+[\.,]?[0-9]*)\s*%/i); return m ? normalizeNumber(m[1]) : null; })();
  const t4 = (() => { const m = text.match(/\bT4\b[^%]{0,80}?([0-9]+[\.,]?[0-9]*)\s*%/i); return m ? normalizeNumber(m[1]) : null; })();
  const t5p = (() => { const m = text.match(/T5\s*(et\s*plus|\+)\b[^%]{0,80}?([0-9]+[\.,]?[0-9]*)\s*%/i); return m ? normalizeNumber(m[2]) : null; })();

  // Type logement: maison/appartement (often in %)
  const partMaison = (() => { const m = text.match(/Maisons?\s*[0-9\u00a0\s]+\s*([0-9]+[\.,]?[0-9]*)\s*%/i); return m ? normalizeNumber(m[1]) : null; })();
  const partAppartement = (() => { const m = text.match(/Appartements?\s*[0-9\u00a0\s]+\s*([0-9]+[\.,]?[0-9]*)\s*%/i); return m ? normalizeNumber(m[1]) : null; })();

  // HLM / locataires (often in %)
  const hlm = (() => { const m = text.match(/\bHLM\b[^%]{0,120}?([0-9]+[\.,]?[0-9]*)\s*%/i); return m ? normalizeNumber(m[1]) : null; })();
  const locataires = (() => { const m = text.match(/Locataires?[^%]{0,120}?([0-9]+[\.,]?[0-9]*)\s*%/i); return m ? normalizeNumber(m[1]) : null; })();

  // Age médian / revenu annuel moyen: L'Internaute sometimes shows these too, but user asked MA for revenue.
  const ageMedian = (() => { const m = text.match(/Âge\s*médian[^0-9]{0,40}([0-9]+[\.,]?[0-9]*)/i); return m ? normalizeNumber(m[1]) : null; })();

  res.json({
    sourceUrl: url,
    parts: {
      residence_principale: partRP,
      residence_secondaire: partRS,
      logement_vacant: vacants,
      maison: partMaison,
      appartement: partAppartement,
      hlm,
      locataires
    },
    tailles: { t1, t2, t3, t4, t5_plus: t5p },
    age_median: ageMedian
  });
});

// -------------------------
// MeilleursAgents: screenshot (and best-effort parsing)
// -------------------------
app.get('/api/meilleursagents', async (req, res) => {
  const { nom, cp } = req.query;
  if (!nom || !cp) return res.status(400).json({ error: 'missing nom or cp' });

  const slug = String(nom)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const url = `https://www.meilleursagents.com/prix-immobilier/${slug}-${cp}/`;

  // Puppeteer screenshot (most robust)
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36');

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

    // Try to extract some numbers from page text (best-effort)
    const pageText = await page.evaluate(() => document.body.innerText);
    const cleaned = pageText.replace(/\s+/g, ' ');

    function pick(regex) {
      const m = cleaned.match(regex);
      return m ? normalizeNumber(m[1]) : null;
    }

    const achat_moyen_m2 = pick(/Prix\s*moyen\s*au\s*m²[^0-9]{0,40}([0-9\s\u00a0]+[\.,]?[0-9]*)/i)
      ?? pick(/m²\s*:?\s*([0-9\s\u00a0]+)\s*€/i);

    const achat_bas_m2 = pick(/Bas\s*:?[^0-9]{0,20}([0-9\s\u00a0]+)\s*€/i);
    const achat_haut_m2 = pick(/Haut\s*:?[^0-9]{0,20}([0-9\s\u00a0]+)\s*€/i);

    const loyer_moyen_m2 = pick(/Loyer\s*moyen\s*au\s*m²[^0-9]{0,40}([0-9\s\u00a0]+[\.,]?[0-9]*)/i);

    const revenu_annuel_moyen = pick(/Revenu\s*(annuel)?\s*moyen[^0-9]{0,40}([0-9\s\u00a0]+[\.,]?[0-9]*)/i);
    const age_median = pick(/Âge\s*médian[^0-9]{0,40}([0-9]+[\.,]?[0-9]*)/i);

    const buffer = await page.screenshot({ fullPage: true, type: 'png' });
    const screenshotBase64 = buffer.toString('base64');

    res.json({
      sourceUrl: url,
      screenshot: `data:image/png;base64,${screenshotBase64}`,
      metrics: {
        achat_moyen_m2,
        achat_bas_m2,
        achat_haut_m2,
        loyer_moyen_m2,
        revenu_annuel_moyen,
        age_median
      }
    });
  } catch (e) {
    res.status(502).json({ error: 'meilleursagents_failed', message: e.message, sourceUrl: url });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// -------------------------
// INSEE: population evolution (optional - needs token)
// -------------------------
app.get('/api/insee/population', async (req, res) => {
  const { code_insee } = req.query;
  const token = process.env.INSEE_BEARER_TOKEN;

  if (!code_insee) return res.status(400).json({ error: 'missing code_insee' });

  if (!token) {
    // We return a helpful payload rather than error, so the front can show instructions.
    return res.json({
      needsToken: true,
      message: 'Ajoute INSEE_BEARER_TOKEN dans .env pour activer cette partie.',
      helpUrl: 'https://api.insee.fr'
    });
  }

  // NOTE: INSEE endpoints vary (BDM/SDMX vs LocalData). Here we leave a placeholder.
  // You can plug the exact endpoint you want once you choose the series.
  return res.json({
    needsToken: true,
    message: "Endpoint INSEE à choisir (BDM / LocalData). Je l'active dès que tu me dis la série / l'indicateur exact.",
    helpUrl: 'https://api.insee.fr'
  });
});

// -------------------------
// Mairie: Google search link
// -------------------------
app.get('/api/mairie_link', (req, res) => {
  const { nom, cp } = req.query;
  if (!nom) return res.status(400).json({ error: 'missing nom' });
  res.json({ url: googleMairieQuery(String(nom), cp ? String(cp) : '') });
});

app.listen(PORT, () => {
  console.log(`✅ Secteur Analyzer backend running on http://localhost:${PORT}`);
});
