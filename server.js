require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');

const app = express();
app.set('trust proxy', 1);

app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── SERVE WEBSITE ───
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── CONFIG ───
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT   = process.env.TELEGRAM_ADMIN_CHAT;
const PORT         = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!BOT_TOKEN || !ADMIN_CHAT || !DATABASE_URL) {
  console.error('Missing env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT, DATABASE_URL');
  process.exit(1);
}

// ─── DATABASE ───
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS clicks (id SERIAL PRIMARY KEY, ip TEXT NOT NULL, clicked_at TIMESTAMPTZ DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS logs (id SERIAL PRIMARY KEY, event TEXT NOT NULL, detail TEXT, created_at TIMESTAMPTZ DEFAULT NOW());`);
  const defaults = {
    count:'0', target:'100', ca:'', launched:'false',
    locked:'false', lock_msg:'The tide is retreating. The depths are recalibrating.',
    decree:'', tide_warning:'', blessed:''
  };
  for (const [k, v] of Object.entries(defaults)) {
    await pool.query(`INSERT INTO state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [k, v]);
  }
  console.log('Database ready');
}

async function getState(key) {
  const r = await pool.query('SELECT value FROM state WHERE key=$1', [key]);
  return r.rows[0]?.value ?? null;
}
async function setState(key, value) {
  await pool.query(`INSERT INTO state (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, String(value)]);
}
async function getAllState() {
  const r = await pool.query('SELECT key, value FROM state');
  const obj = {};
  r.rows.forEach(row => obj[row.key] = row.value);
  return obj;
}
async function addLog(event, detail='') {
  await pool.query('INSERT INTO logs (event, detail) VALUES ($1, $2)', [event, detail]);
}

// ─── TELEGRAM ───
async function tg(text) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_CHAT, text, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('Telegram error:', e.message); }
}

// ─── ANTI-SPAM ───
async function hasIPClicked(ip) {
  const r = await pool.query(`SELECT id FROM clicks WHERE ip=$1 AND clicked_at > NOW() - INTERVAL '24 hours'`, [ip]);
  return r.rows.length > 0;
}
async function recordIPClick(ip) {
  await pool.query('INSERT INTO clicks (ip) VALUES ($1)', [ip]);
}

// ─── GET /state ───
app.get('/state', async (req, res) => {
  try {
    const s = await getAllState();
    res.json({
      count: parseInt(s.count)||0,
      target: parseInt(s.target)||100,
      ca: s.ca||null,
      launched: s.launched==='true',
      locked: s.locked==='true',
      lock_msg: s.lock_msg||'',
      decree: s.decree||'',
      tide_warning: s.tide_warning||'',
      blessed: s.blessed||''
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /click ───
const clickLimiter = rateLimit({
  windowMs: 24*60*60*1000, max:1,
  keyGenerator: (req) => req.ip,
  handler: (req,res) => res.status(429).json({ error:'already_clicked' }),
  standardHeaders:false, legacyHeaders:false
});

app.post('/click', clickLimiter, async (req, res) => {
  try {
    const ip = req.ip;
    if (await hasIPClicked(ip)) return res.status(429).json({ error:'already_clicked' });
    const locked = await getState('locked');
    if (locked==='true') {
      return res.status(423).json({ error:'locked', message: await getState('lock_msg') });
    }
    const count  = parseInt(await getState('count'))||0;
    const target = parseInt(await getState('target'))||100;
    const n = count+1;
    await setState('count', n);
    await recordIPClick(ip);
    await addLog('click', `IP:${ip} Count:${n}`);

    if (n%10===0) {
      const pct = Math.round((n/target)*100);
      let msg = `🌊 <b>Tide Update</b>\n\n<b>${n} / ${target}</b> fed the tide pool (${pct}%)`;
      if (n===Math.floor(target*0.5))  msg+=`\n\n<i>Halfway. The sediment stirs.</i>`;
      if (n===Math.floor(target*0.75)) msg+=`\n\n<i>Three quarters. Something vast moves beneath.</i>`;
      if (n===target-10)               msg+=`\n\n⚠️ <i>10 remaining. The tide pool trembles.</i>`;
      await tg(msg);
    }

    const blessed = await getState('blessed');
    if (blessed && parseInt(blessed)===n) {
      await tg(`🦞 <b>The Blessed One has arrived.</b>\nClick #${n} has fed the tide pool.`);
    }

    if (n>=target) {
      const wasLaunched = await getState('launched');
      if (wasLaunched!=='true') {
        await setState('launched','true');
        await tg(`🎉 <b>THE TIDE POOL IS UNLEASHED</b>\n\n<b>${n}</b> have offered themselves.\n\nSend the CA now:\n<code>/setCA YourSolanaAddressHere</code>\n\nOr whenever you are ready.`);
      }
    }
    res.json({ count:n, target, launched:n>=target });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error:e.message });
  }
});

// ─── GET /ping ───
app.get('/ping', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok:true, time:new Date().toISOString() }); }
  catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ─── TELEGRAM WEBHOOK ───
const pendingConfirm = {};

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.message;
    if (!msg) return;
    const chatId = String(msg.chat?.id);
    const text   = (msg.text||'').trim();
    if (chatId!==String(ADMIN_CHAT)) return;
    await addLog('tg_command', text.slice(0,120));

    if (text==='CONFIRM' && pendingConfirm[chatId]) {
      const {command, expiresAt} = pendingConfirm[chatId];
      delete pendingConfirm[chatId];
      if (Date.now()>expiresAt) return tg('Confirmation expired. Send the command again.');
      return handleConfirmed(command);
    }

    const parts = text.split(' ');
    const cmd   = parts[0].toLowerCase();
    const arg   = parts.slice(1).join(' ').trim();

    if (cmd==='/ping') {
      await pool.query('SELECT 1');
      const count=await getState('count'), target=await getState('target'), ca=await getState('ca');
      await tg(`✅ <b>All systems alive.</b>\n\nDatabase: online\nCount: <b>${count}/${target}</b>\nCA: <b>${ca?'set':'not set'}</b>`);
    }
    else if (cmd==='/count') {
      const c=await getState('count'), t=await getState('target');
      await tg(`🌊 Count: <b>${c} / ${t}</b> (${Math.round(parseInt(c)/parseInt(t)*100)}%)`);
    }
    else if (cmd==='/status') {
      const s=await getAllState();
      await tg(`📊 <b>Status</b>\n\nCount: <b>${s.count}/${s.target}</b>\nLaunched: <b>${s.launched}</b>\nLocked: <b>${s.locked}</b>\nCA: <b>${s.ca||'not set'}</b>\nDecree: <b>${s.decree||'none'}</b>\nWarning: <b>${s.tide_warning||'none'}</b>\nBlessed: <b>${s.blessed||'none'}</b>`);
    }
    else if (cmd==='/setca') {
      if (!arg||arg.length<10) return tg('Usage: /setCA YourSolanaContractAddress');
      await setState('ca',arg); await addLog('set_ca',arg);
      await tg(`✅ <b>Contract address live.</b>\n\n<code>${arg}</code>\n\nSite updates within 30 seconds.`);
    }
    else if (cmd==='/decree') {
      if (!arg) return tg('Usage: /decree Your message here');
      await setState('decree',arg); await addLog('decree',arg);
      await tg(`✅ Decree live:\n<i>"${arg}"</i>`);
    }
    else if (cmd==='/cleardecree') {
      await setState('decree','');
      await tg('✅ Decree cleared. Daily quote restored.');
    }
    else if (cmd==='/bless') {
      const n=parseInt(arg);
      if (!n||n<1) return tg('Usage: /bless 42');
      await setState('blessed',String(n));
      await tg(`✅ Click <b>#${n}</b> marked as The Blessed One.`);
    }
    else if (cmd==='/lockdown') {
      const m=arg||'The tide is retreating. The depths are recalibrating.';
      await setState('locked','true'); await setState('lock_msg',m); await addLog('lockdown',m);
      await tg(`🔒 <b>Site locked.</b>\n\n<i>"${m}"</i>\n\nUse /unlock to reopen.`);
    }
    else if (cmd==='/unlock') {
      await setState('locked','false'); await addLog('unlock','');
      await tg('🔓 Site unlocked. Button active again.');
    }
    else if (cmd==='/settarget') {
      const n=parseInt(arg);
      if (!n||n<1) return tg('Usage: /settarget 150');
      await setState('target',String(n)); await addLog('set_target',String(n));
      await tg(`✅ Target updated to <b>${n}</b>.`);
    }
    else if (cmd==='/today') {
      const r=await pool.query(`SELECT COUNT(*) as cnt FROM clicks WHERE clicked_at>NOW()-INTERVAL '24 hours'`);
      const total=await getState('count'), target=await getState('target');
      await tg(`📅 Last 24h: <b>${r.rows[0].cnt}</b> offerings\nTotal: <b>${total}/${target}</b>`);
    }
    else if (cmd==='/velocity') {
      const r6=await pool.query(`SELECT COUNT(*) as cnt FROM clicks WHERE clicked_at>NOW()-INTERVAL '6 hours'`);
      const r1=await pool.query(`SELECT COUNT(*) as cnt FROM clicks WHERE clicked_at>NOW()-INTERVAL '1 hour'`);
      const c6=parseInt(r6.rows[0].cnt), c1=parseInt(r1.rows[0].cnt), avg=(c6/6).toFixed(1);
      let trend='➡️ Steady';
      if(c1>avg*1.5) trend='📈 Surging';
      else if(c1<avg*0.5&&c6>0) trend='📉 Stalling';
      await tg(`⚡ <b>Velocity</b>\n\nLast hour: <b>${c1}</b>\n6h avg: <b>${avg}/hr</b>\n${trend}`);
    }
    else if (cmd==='/tidewarning') {
      const m=arg||'The tide pool closes soon. The window is narrowing.';
      await setState('tide_warning',m); await addLog('tide_warning',m);
      await tg(`⚠️ Warning set:\n<i>"${m}"</i>`);
    }
    else if (cmd==='/cleartidewarning') {
      await setState('tide_warning','');
      await tg('✅ Tide warning cleared.');
    }
    else if (cmd==='/logs') {
      const r=await pool.query(`SELECT event,detail,created_at FROM logs ORDER BY created_at DESC LIMIT 20`);
      if (!r.rows.length) return tg('No logs yet.');
      let out='📋 <b>Last 20 events:</b>\n\n';
      r.rows.forEach(row=>{
        const t=new Date(row.created_at).toISOString().slice(11,19);
        out+=`<code>${t}</code> <b>${row.event}</b>${row.detail?' — '+row.detail.slice(0,50):''}\n`;
      });
      await tg(out);
    }
    else if (cmd==='/reset') {
      pendingConfirm[chatId]={command:'reset',expiresAt:Date.now()+60000};
      await tg('⚠️ <b>RESET WARNING</b>\n\nThis wipes count, CA, and all click records.\n\nReply <b>CONFIRM</b> within 60 seconds to proceed.');
    }
    else if (cmd==='/help') {
      await tg(`🦞 <b>Clawtherion Commands</b>\n\n/ping /count /status /today /velocity /logs\n/setCA &lt;addr&gt;\n/decree &lt;msg&gt; — /cleardecree\n/bless &lt;n&gt;\n/settarget &lt;n&gt;\n/lockdown [msg] — /unlock\n/tidewarning [msg] — /cleartidewarning\n/reset`);
    }
    else {
      await tg(`Unknown: <code>${cmd}</code> — send /help`);
    }
  } catch (e) {
    console.error('Webhook error:', e);
    await tg(`Error: ${e.message}`);
  }
});

async function handleConfirmed(command) {
  if (command==='reset') {
    await pool.query(`UPDATE state SET value='0' WHERE key='count'`);
    await pool.query(`UPDATE state SET value='' WHERE key IN ('ca','blessed','decree','tide_warning')`);
    await pool.query(`UPDATE state SET value='false' WHERE key='launched'`);
    await pool.query(`DELETE FROM clicks`);
    await addLog('reset','Full reset');
    await tg('✅ Reset complete. Count is 0. All cleared.');
  }
}

app.get('/setup-webhook', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.send('Provide ?url=https://your-app.up.railway.app');
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ url: url+'/webhook' })
    });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error:e.message }); }
});

setInterval(async () => {
  try {
    if ((await getState('launched'))==='true') return;
    const r=await pool.query(`SELECT COUNT(*) as cnt FROM clicks WHERE clicked_at>NOW()-INTERVAL '3 hours'`);
    if (parseInt(r.rows[0].cnt)===0) {
      const count=await getState('count'), target=await getState('target');
      await tg(`😴 <b>Tide stalling</b>\n\nNo offerings in 3 hours.\nCount: <b>${count}/${target}</b>\n\nPost on X or use /decree to stir activity.`);
    }
  } catch(e) {}
}, 3*60*60*1000);

initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`Clawtherion running on port ${PORT}`));
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
