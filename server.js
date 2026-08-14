const express = require('express');
const twilio  = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ── ENV ── */
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  ANTHROPIC_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  PORT = 3000
} = process.env;

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const ai = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

/* ── HEALTH CHECK ── */
app.get('/', (_req, res) => res.send('Qwote.ai WhatsApp backend running ✅'));

/* ── HELPERS ── */
const fmt$ = n => '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const last10 = s => (s || '').replace(/\D/g, '').slice(-10);
const quoteNum = () => 'Q-' + (1000 + Math.floor(Math.random() * 9000));

/* ── CLAUDE SYSTEM PROMPT ── */
const SYSTEM = `You are a quoting assistant for a US trades business (plumbing, electrical, HVAC, etc).
Extract quote details from the tradie's message and return ONLY valid JSON — no explanation, no markdown.

Return this exact structure:
{
  "customer_name": "string or null",
  "customer_contact": "string or null",
  "job_address": "string or null",
  "job_description": "string or null",
  "materials": [{ "desc": "string", "qty": number, "unit_price": number }],
  "labour": [{ "desc": "string", "hours": number, "rate": number }],
  "markup_percent": number,
  "discount_type": "percent",
  "discount_value": number,
  "deposit": number,
  "tax_rate": number,
  "payment_terms": "string or null",
  "notes": "string or null"
}

Rules:
- Default markup_percent, discount_value, deposit, tax_rate to 0 if not mentioned
- If hours/rate not specified but labour is mentioned, make best guess
- If materials mentioned without price, estimate reasonable US trade prices
- Extract tax rate from context (e.g. "Illinois" = 6.25%, "Texas" = 6.25%, "California" = 7.25%)`;

/* ── WHATSAPP WEBHOOK ── */
app.post('/webhook', async (req, res) => {
  const { Body, From } = req.body;

  // Twilio reply helper
  const twiml = new twilio.twiml.MessagingResponse();
  const reply = txt => {
    twiml.message(txt);
    res.type('text/xml').send(twiml.toString());
  };

  try {
    const senderPhone = From.replace('whatsapp:', '');
    const senderDigits = last10(senderPhone);

    /* ── LOOK UP USER ── */
    const { data: profiles, error: profileErr } = await sb.from('profiles').select('*');
    if (profileErr) throw profileErr;

    const profile = profiles?.find(p => last10(p.phone) === senderDigits);

    if (!profile) {
      return reply(
        `👋 Hey! You need a Qwote.ai account to use this.\n\n` +
        `Sign up free at qwote-ai.netlify.app — takes 2 minutes and your details are saved forever after that.\n\n` +
        `Once you're registered, come back and describe any job — I'll build the quote instantly.`
      );
    }

    const msgText = (Body || '').trim();

    /* ── HELP MESSAGE ── */
    if (!msgText || ['hi', 'hello', 'hey', 'help'].includes(msgText.toLowerCase())) {
      return reply(
        `👋 Hey ${profile.business_name?.split(' ')[0] || 'there'}! Ready to quote.\n\n` +
        `Just describe the job like:\n` +
        `_"Quote for Dave Johnson at 142 Oak St Chicago — replace burst pipe, 2 hours at $95/hr, $180 materials with 20% markup, 8.5% tax, $100 deposit"_\n\n` +
        `I'll build it and send you the link.`
      );
    }

    /* ── PARSE WITH CLAUDE ── */
    const claudeRes = await ai.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `Business: ${profile.business_name} | Phone: ${profile.phone}\nMessage: ${msgText}`
      }]
    });

    let qd;
    try {
      const raw = claudeRes.content[0].text.trim().replace(/```json|```/g, '');
      qd = JSON.parse(raw);
    } catch {
      return reply(
        `Hmm, I couldn't turn that into a quote.\n\n` +
        `Try: _"Quote for [name] at [address] — [job description], [hours] hrs at $[rate]/hr, $[materials] materials"_`
      );
    }

    /* ── CALCULATE TOTALS ── */
    const markup  = parseFloat(profile.markup_default) || qd.markup_percent || 0;
    const taxRate = parseFloat(profile.tax_rate_default) || qd.tax_rate || 0;
    const payTerms = qd.payment_terms || profile.payment_terms_default || null;

    const materials = (qd.materials || []).map(m => {
      const unit = m.unit_price * (1 + markup / 100);
      return { desc: m.desc, qty: m.qty, price: m.unit_price, mk: markup, unit, line: m.qty * unit };
    });
    const labour = (qd.labour || []).map(l => ({
      desc: l.desc, hrs: l.hours, rate: l.rate, line: l.hours * l.rate
    }));

    const matSub   = materials.reduce((s, m) => s + m.line, 0);
    const labSub   = labour.reduce((s, l)   => s + l.line, 0);
    const rawSub   = matSub + labSub;
    const dv       = qd.discount_value || 0;
    const disc     = dv > 0 ? (qd.discount_type === 'percent' ? rawSub * dv / 100 : dv) : 0;
    const taxBase  = rawSub - disc;
    const tax      = taxBase * (taxRate / 100);
    const total    = taxBase + tax;
    const dep      = qd.deposit || 0;

    const qNum = quoteNum();
    const now  = new Date();

    /* ── SAVE TO SUPABASE ── */
    const { data: saved, error: saveErr } = await sb.from('quotes').insert({
      user_id:          profile.id,
      quote_num:        qNum,
      date:             fmtDate(now),
      expiry:           fmtDate(new Date(now.getTime() + 30 * 86400000)),
      customer_name:    qd.customer_name    || null,
      customer_contact: qd.customer_contact || null,
      job_address:      qd.job_address      || null,
      job_description:  qd.job_description  || null,
      materials,
      labour,
      markup,
      discount_type:    qd.discount_type    || 'percent',
      discount_value:   dv,
      deposit:          dep,
      tax_rate:         taxRate,
      payment_terms:    payTerms,
      notes:            qd.notes            || null,
      total,
      status:           'draft'
    }).select().single();

    if (saveErr) {
      console.error('Save error:', saveErr);
      return reply('Quote built but had trouble saving — try again or visit qwote-ai.netlify.app');
    }

    /* ── FORMAT REPLY ── */
    let msg = `✅ *${qNum} — ${qd.customer_name || 'New Quote'}*\n`;
    if (qd.job_address)      msg += `📍 ${qd.job_address}\n`;
    if (qd.job_description)  msg += `🔧 ${qd.job_description}\n`;
    msg += `\n`;
    if (matSub > 0)  msg += `Materials:  ${fmt$(matSub)}\n`;
    if (labSub > 0)  msg += `Labour:     ${fmt$(labSub)}\n`;
    if (disc > 0)    msg += `Discount:   -${fmt$(disc)}\n`;
    if (tax > 0)     msg += `Tax ${taxRate}%:   ${fmt$(tax)}\n`;
    msg += `━━━━━━━━━━━━\n`;
    msg += `*TOTAL: ${fmt$(total)}*\n`;
    if (dep > 0)     msg += `Deposit due: ${fmt$(dep)}\n`;
    msg += `\n📄 View & download PDF:\nqwote-ai.netlify.app#q=${saved.id}`;

    reply(msg);

  } catch (err) {
    console.error('Webhook error:', err);
    reply('Something went wrong — try again or visit qwote-ai.netlify.app');
  }
});

app.listen(PORT, () => console.log(`Qwote.ai WhatsApp server on port ${PORT}`));
