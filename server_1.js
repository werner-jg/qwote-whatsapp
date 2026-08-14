const express = require('express');
const twilio  = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { jsPDF } = require('jspdf');
require('jspdf-autotable');

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

/* ── GENERATE PDF + UPLOAD TO SUPABASE STORAGE ── */
async function generateAndUploadPDF(saved, qd, profile, totals, qNum){
  try{
    const { ms, labSub, disc, taxRate, tax, total, dep, balance } = totals;
    const fmt$ = n => '$'+(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    const doc = new jsPDF({unit:'mm',format:'letter'});
    const W=215.9, mg=18; let y=0;

    // Orange header
    doc.setFillColor(255,98,0);doc.rect(0,0,W,9,'F');
    doc.setFont('helvetica','bold');doc.setFontSize(6.5);doc.setTextColor(255,255,255);
    doc.text('QWOTE.AI',W/2,5.8,{align:'center'});
    doc.setFillColor(255,98,0);doc.rect(0,0,4,279.4,'F');
    y=20;

    // Quote label
    doc.setFont('helvetica','bold');doc.setFontSize(34);doc.setTextColor(220,218,214);
    doc.text('QUOTE',mg+4,y+6);
    doc.setFont('helvetica','normal');doc.setFontSize(8.5);doc.setTextColor(110,105,100);
    doc.text([qNum,'Date: '+saved.date,'Expires: '+saved.expiry],mg+4,y+13,{lineHeightFactor:1.75});

    // Business info
    doc.setFont('helvetica','bold');doc.setFontSize(12);doc.setTextColor(26,23,20);
    doc.text(profile.business_name||'Your Business',W-mg,y+5,{align:'right'});
    doc.setFont('helvetica','normal');doc.setFontSize(8.5);doc.setTextColor(110,105,100);
    const bl=[profile.phone,profile.email].filter(Boolean);
    if(bl.length)doc.text(bl,W-mg,y+11,{align:'right',lineHeightFactor:1.8});
    y+=36;

    // Divider
    doc.setDrawColor(220,218,214);doc.setLineWidth(0.4);doc.line(mg,y,W-mg,y);y+=7;

    // Bill to / job site
    const cw=(W-mg*2-8)/2;
    doc.setFillColor(246,244,239);doc.roundedRect(mg,y,W-mg*2,30,2,2,'F');y+=5;
    doc.setFont('helvetica','bold');doc.setFontSize(7);doc.setTextColor(130,125,120);
    doc.text('BILL TO',mg+4,y);doc.text('JOB SITE',mg+cw+12,y);y+=4.5;
    doc.setFont('helvetica','bold');doc.setFontSize(10);doc.setTextColor(26,23,20);
    doc.text(saved.customer_name||'—',mg+4,y);
    doc.text(doc.splitTextToSize(saved.job_address||'—',cw-4),mg+cw+12,y);y+=5;
    doc.setFont('helvetica','normal');doc.setFontSize(8.5);doc.setTextColor(110,105,100);
    doc.text(saved.customer_contact||'',mg+4,y);y+=12;

    // Scope of work
    if(saved.job_description){
      doc.setFont('helvetica','bold');doc.setFontSize(7);doc.setTextColor(130,125,120);
      doc.text('SCOPE OF WORK',mg,y);y+=4;
      doc.setFont('helvetica','normal');doc.setFontSize(9);doc.setTextColor(26,23,20);
      const dl=doc.splitTextToSize(saved.job_description,W-mg*2);
      doc.text(dl,mg,y);y+=dl.length*4.5+5;
    } else {y+=4;}

    // Materials
    const mats = saved.materials||[];
    const labs = saved.labour||[];
    if(mats.length){
      doc.setFont('helvetica','bold');doc.setFontSize(7);doc.setTextColor(130,125,120);
      doc.text('MATERIALS',mg,y);y+=2;
      doc.autoTable({startY:y,margin:{left:mg,right:mg},
        head:[['Item','Qty','Unit Price','Total']],
        body:mats.map(m=>[m.desc+(m.mk>0?` (+${m.mk}% markup)`:''),m.qty,fmt$(m.unit),fmt$(m.line)]),
        headStyles:{fillColor:[240,238,234],textColor:[110,105,100],fontStyle:'bold',fontSize:7.5},
        bodyStyles:{fontSize:8.5,textColor:[40,38,36]},
        columnStyles:{0:{cellWidth:'auto'},1:{halign:'right',cellWidth:14},2:{halign:'right',cellWidth:28},3:{halign:'right',cellWidth:28}},
        theme:'grid',styles:{lineColor:[220,218,214],lineWidth:.3}});
      y=doc.lastAutoTable.finalY+5;
    }
    if(labs.length){
      doc.setFont('helvetica','bold');doc.setFontSize(7);doc.setTextColor(130,125,120);
      doc.text('LABOUR',mg,y);y+=2;
      doc.autoTable({startY:y,margin:{left:mg,right:mg},
        head:[['Description','Hours','Rate','Total']],
        body:labs.map(l=>[l.desc,l.hrs+' hrs',fmt$(l.rate)+'/hr',fmt$(l.line)]),
        headStyles:{fillColor:[240,238,234],textColor:[110,105,100],fontStyle:'bold',fontSize:7.5},
        bodyStyles:{fontSize:8.5,textColor:[40,38,36]},
        columnStyles:{0:{cellWidth:'auto'},1:{halign:'right',cellWidth:20},2:{halign:'right',cellWidth:26},3:{halign:'right',cellWidth:28}},
        theme:'grid',styles:{lineColor:[220,218,214],lineWidth:.3}});
      y=doc.lastAutoTable.finalY+5;
    }

    // Totals
    const tx2=W-mg-72;
    const rows=[['Materials',fmt$(ms),false],['Labour',fmt$(labSub),false]];
    if(disc>0)rows.push([`Discount`,`-${fmt$(disc)}`,false,'green']);
    const taxBase=Math.max(0,(ms+labSub)-disc);
    rows.push(['Subtotal',fmt$(taxBase),false]);
    if(taxRate>0)rows.push([`Sales Tax (${taxRate}%)`,fmt$(tax),false]);
    rows.push(['TOTAL DUE',fmt$(total),true]);
    rows.forEach(r=>{
      const last=r[2],isGr=r[3]==='green';
      if(last){doc.setDrawColor(200,196,190);doc.setLineWidth(.4);doc.line(tx2,y-1,W-mg,y-1);y+=2;}
      doc.setFont('helvetica',last?'bold':'normal');doc.setFontSize(last?11:8.5);
      doc.setTextColor(last?26:110,last?23:105,last?20:100);doc.text(r[0],tx2,y);
      if(isGr)doc.setTextColor(16,160,88);else doc.setTextColor(last?211:40,last?95:38,last?0:36);
      doc.text(r[1],W-mg,y,{align:'right'});y+=last?6:4.5;
    });
    if(dep>0){
      doc.setFont('helvetica','bold');doc.setFontSize(8.5);doc.setTextColor(110,105,100);
      doc.text('Deposit required',tx2,y);doc.setTextColor(40,38,36);doc.text(fmt$(dep),W-mg,y,{align:'right'});y+=4.5;
      doc.setTextColor(16,160,88);doc.text('Balance on completion',tx2,y);doc.text(fmt$(balance),W-mg,y,{align:'right'});
    }

    // Footer
    doc.setFillColor(255,98,0);doc.rect(0,272.4,W,7,'F');
    doc.setFont('helvetica','bold');doc.setFontSize(6);doc.setTextColor(255,255,255);
    doc.text('Generated by Qwote.ai · Powered by Maintayn.ai',W/2,276.4,{align:'center'});

    // Upload to Supabase Storage
    const pdfBuffer = Buffer.from(doc.output('arraybuffer'));
    const fileName = `${saved.id}.pdf`;
    const { error: uploadErr } = await sb.storage.from('quotes').upload(fileName, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true
    });
    if(uploadErr)throw uploadErr;

    const { data: urlData } = sb.storage.from('quotes').getPublicUrl(fileName);
    return urlData.publicUrl;
  } catch(e){
    console.error('PDF gen error:',e);
    return null;
  }
}

    /* ── FORMAT REPLY ── */
    const totalsObj = { ms: matSub, labSub, disc, taxRate, tax, total, dep, balance: Math.max(0, total - dep) };
    const pdfUrl = await generateAndUploadPDF(saved, qd, profile, totalsObj, qNum);
    const name = qd.customer_name ? ` for *${qd.customer_name}*` : '';
    let msg = `✅ *Quote ${qNum}*${name}\n\n`;
    msg += `👁 View quote:\nhttps://qwote-ai.netlify.app#q=${saved.id}\n\n`;
    if(pdfUrl) msg += `📥 Download PDF:\n${pdfUrl}`;
    else msg += `📄 Download PDF from the view link above`;

    reply(msg);

  } catch (err) {
    console.error('Webhook error:', err);
    reply('Something went wrong — try again or visit qwote-ai.netlify.app');
  }
});

app.listen(PORT, () => console.log(`Qwote.ai WhatsApp server on port ${PORT}`));
