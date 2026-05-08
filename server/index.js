const express = require('express');
const multer = require('multer');
const sgMail = require('@sendgrid/mail');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// R2 Storage
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});
const BUCKET = process.env.R2_BUCKET || 'primetime-videos';

// Temp uploads
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Neon PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS realtors (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      company TEXT,
      phone TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      title TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sends (
      id SERIAL PRIMARY KEY,
      video_id TEXT NOT NULL,
      realtor_id INTEGER NOT NULL,
      realtor_name TEXT,
      realtor_email TEXT,
      message TEXT,
      subject TEXT,
      sent_at TIMESTAMP DEFAULT NOW(),
      viewed BOOLEAN DEFAULT FALSE,
      viewed_at TIMESTAMP,
      view_count INTEGER DEFAULT 0
    );
  `);
  console.log('✅ Database ready');
}
initDB().catch(console.error);

// Multer - temp storage
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${uuidv4()}.webm`)
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// Upload video -> R2
app.post('/api/upload', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const id = path.parse(req.file.filename).name;
  const fileBuffer = fs.readFileSync(req.file.path);
  
  try {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: req.file.filename,
      Body: fileBuffer,
      ContentType: 'video/webm'
    }));
    fs.unlinkSync(req.file.path); // clean up temp file
    console.log('✅ Video uploaded to R2:', req.file.filename);
  } catch(e) {
    console.error('R2 upload error:', e.message);
  }

  await pool.query('INSERT INTO videos (id, filename, title) VALUES ($1, $2, $3)', [id, req.file.filename, req.body.title || 'Monday Greeting']);
  res.json({ id, url: `/watch/${id}` });
});

// Serve video from R2
app.get('/uploads/:filename', async (req, res) => {
  try {
    const url = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: BUCKET,
      Key: req.params.filename
    }), { expiresIn: 3600 });
    res.redirect(url);
  } catch(e) {
    console.error('R2 get error:', e.message);
    res.status(404).send('Video not found');
  }
});

// Get realtors
app.get('/api/realtors', async (req, res) => {
  const result = await pool.query('SELECT * FROM realtors ORDER BY name ASC');
  res.json(result.rows);
});

// Add realtor
app.post('/api/realtors', async (req, res) => {
  const { name, email, company, phone } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  try {
    const result = await pool.query('INSERT INTO realtors (name, email, company, phone) VALUES ($1, $2, $3, $4) RETURNING *', [name, email, company || '', phone || '']);
    res.json(result.rows[0]);
  } catch (e) {
    res.status(400).json({ error: 'Email already exists' });
  }
});

// Delete realtor
app.delete('/api/realtors/:id', async (req, res) => {
  await pool.query('DELETE FROM realtors WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// Send videos
app.post('/api/send', async (req, res) => {
  const { videoId, realtorIds, subject, message } = req.body;
  const video = await pool.query('SELECT * FROM videos WHERE id = $1', [videoId]);
  if (!video.rows[0]) return res.status(404).json({ error: 'Video not found' });

  const realtors = (await Promise.all(realtorIds.map(id => pool.query('SELECT * FROM realtors WHERE id = $1', [id])))).map(r => r.rows[0]).filter(Boolean);
  if (!realtors.length) return res.status(400).json({ error: 'No valid realtors' });

  const sendRecords = [];
  for (const r of realtors) {
    const personalMsg = message.replace(/{name}/g, r.name.split(' ')[0]);
    const result = await pool.query('INSERT INTO sends (video_id, realtor_id, realtor_name, realtor_email, message, subject) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [videoId, r.id, r.name, r.email, personalMsg, subject]);
    sendRecords.push({ sendId: result.rows[0].id, realtor: r, message: personalMsg });
  }

  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SMTP_EMAIL || 'paul@teamprimetimeloans.com';

  if (apiKey) {
    try {
      sgMail.setApiKey(apiKey);
      const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
      for (const { sendId, realtor, message: personalMsg } of sendRecords) {
        const watchUrl = `${baseUrl}/watch/${videoId}?sid=${sendId}`;
        const firstName = realtor.name.split(' ')[0];
        const html = generateEmailHTML(firstName, personalMsg, watchUrl, videoId, baseUrl);
        await sgMail.send({
          from: { email: fromEmail, name: 'Paul PT Terwilliger - Team Prime Time' },
          to: realtor.email,
          subject: subject.replace(/{name}/g, firstName),
          html
        });
      }
      res.json({ success: true, sent: realtors.length, mode: 'email' });
    } catch (e) {
      console.error('Email error:', e.message, JSON.stringify(e.response && e.response.body));
      res.json({ success: true, sent: realtors.length, mode: 'preview', error: e.message });
    }
  } else {
    res.json({ success: true, sent: realtors.length, mode: 'preview', sendRecords });
  }
});

// Track view
app.get('/api/track/:sendId', async (req, res) => {
 await pool.query('UPDATE sends SET viewed = TRUE, view_count = view_count + 1, viewed_at = NOW() WHERE id::text = $1', [parseInt(req.params.sendId)]);
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': pixel.length });
  res.end(pixel);
});

// Stats
app.get('/api/stats', async (req, res) => {
  const [sent, viewed, recent, realtors] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM sends'),
    pool.query('SELECT COUNT(*) FROM sends WHERE viewed = TRUE'),
    pool.query('SELECT s.*, v.title as video_title FROM sends s LEFT JOIN videos v ON s.video_id = v.id ORDER BY s.sent_at DESC LIMIT 20'),
    pool.query('SELECT COUNT(*) FROM realtors')
  ]);
  res.json({
    totalSent: parseInt(sent.rows[0].count),
    totalViewed: parseInt(viewed.rows[0].count),
    recentSends: recent.rows,
    realtorCount: parseInt(realtors.rows[0].count)
  });
});

// Watch page
app.get('/watch/:videoId', async (req, res) => {
  const id = req.params.videoId;
  const sendId = req.query.sid;
  const video = await pool.query('SELECT * FROM videos WHERE id = $1', [id]);
  if (!video.rows[0]) return res.status(404).send('Video not found');
  let realtorName = '';
  if (sendId) {
    const send = await pool.query('SELECT * FROM sends WHERE id = $1', [sendId]);
    if (send.rows[0]) realtorName = send.rows[0].realtor_name;
  }
  res.send(generateWatchPage(id, video.rows[0].filename, realtorName, sendId));
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('/record', (req, res) => res.sendFile(path.join(__dirname, '../public/pages/record.html')));
app.get('/contacts', (req, res) => res.sendFile(path.join(__dirname, '../public/pages/contacts.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../public/pages/dashboard.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, '../public/pages/settings.html')));

function generateEmailHTML(firstName, message, watchUrl, videoId, baseUrl) {
  const msgHtml = message.replace(/\n/g, '<br>');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Georgia,serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:30px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:600px">
  <tr><td style="background:#0d1b2a;padding:24px 32px;text-align:center">
    <div style="font-family:Georgia,serif;font-size:22px;font-weight:bold;color:#c9a84c">Team Prime Time Loans</div>
    <div style="font-size:11px;color:rgba(255,255,255,0.5);letter-spacing:2px;text-transform:uppercase;margin-top:4px">Paul Terwilliger · NMLS #321929</div>
  </td></tr>
  <tr><td style="padding:32px">
    <p style="font-size:16px;color:#0d1b2a;margin:0 0 24px">Hey ${firstName},</p>
    <a href="${watchUrl}" style="display:block;text-decoration:none;border-radius:10px;overflow:hidden;margin-bottom:24px">
      <div style="background:#0d1b2a;border-radius:10px;padding:60px 20px;text-align:center">
        <div style="width:64px;height:64px;background:#c9a84c;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:12px">▶</div>
        <div style="font-family:Georgia,serif;font-size:18px;color:#c9a84c;font-weight:bold"> ${firstName}!</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.5);letter-spacing:1px;text-transform:uppercase;margin-top:4px">Click to watch Paul's message</div>
      </div>
    </a>
    <div style="font-size:15px;line-height:1.7;color:#333;margin-bottom:28px">${msgHtml}</div>
    <table cellpadding="0" cellspacing="0" style="border-top:2px solid #c9a84c;padding-top:20px;width:100%">
      <tr>
        <td style="width:52px;height:52px;background:#0d1b2a;border-radius:50%;text-align:center;vertical-align:middle;font-family:Georgia,serif;font-size:20px;color:#c9a84c;font-weight:bold">PT</td>
        <td style="padding-left:14px;vertical-align:middle">
          <div style="font-weight:bold;font-size:15px;color:#0d1b2a">Paul Terwilliger</div>
          <div style="font-size:12px;color:#666">Mortgage Broker · Barrett Financial Group</div>
          <div style="font-size:12px;color:#c9a84c;font-weight:bold">(860) 639-8290 · TeamPrimeTimeLoans.com</div>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</td></tr>
</table>
<img src="${baseUrl}/api/track/${videoId}" width="1" height="1" style="display:none">
</body></html>`;
}

function generateWatchPage(videoId, filename, realtorName, sendId) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Message from PT — Team Prime Time Loans</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=DM+Sans:wght@400;600&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0d1b2a;color:#f8f5ef;font-family:'DM Sans',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}.card{background:#162236;border-radius:20px;overflow:hidden;max-width:640px;width:100%;box-shadow:0 40px 80px rgba(0,0,0,0.5)}.card-header{background:#0d1b2a;padding:20px 28px;border-bottom:1px solid rgba(201,168,76,0.2)}.brand{font-family:'Playfair Display',serif;font-size:18px;color:#c9a84c;font-weight:900}.brand-sub{font-size:10px;color:rgba(255,255,255,0.4);letter-spacing:2px;text-transform:uppercase}.video-wrap{background:#000;aspect-ratio:16/9}video{width:100%;height:100%;object-fit:cover;display:block}.card-body{padding:28px}.greeting{font-family:'Playfair Display',serif;font-size:22px;color:#c9a84c;margin-bottom:8px}.sub{font-size:13px;color:rgba(255,255,255,0.5);margin-bottom:24px}.cta-btn{display:block;width:100%;padding:16px;background:linear-gradient(135deg,#c9a84c,#e8c96a);color:#0d1b2a;font-weight:700;font-size:15px;text-align:center;border-radius:10px;text-decoration:none;margin-bottom:12px}.sig{display:flex;align-items:center;gap:14px;margin-top:24px;padding-top:20px;border-top:1px solid rgba(201,168,76,0.2)}.avatar{width:48px;height:48px;background:#0d1b2a;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:'Playfair Display',serif;font-size:18px;color:#c9a84c;font-weight:900;flex-shrink:0}.sig-name{font-weight:700;font-size:14px}.sig-title{font-size:12px;color:rgba(255,255,255,0.5)}.sig-contact{font-size:12px;color:#c9a84c;font-weight:600}</style>
</head><body>
<div class="card">
  <div class="card-header"><div class="brand">Team Prime Time Loans</div><div class="brand-sub">Paul Terwilliger · NMLS #321929</div></div>
  <div class="video-wrap"><video controls autoplay playsinline src="/uploads/${filename}"></video></div>
  <div class="card-body">
    <div class="greeting">Good morning${realtorName ? ', ' + realtorName.split(' ')[0] : ''}! 👋</div>
    <div class="sub">A personal message from your mortgage guy, Paul</div>
    <a href="tel:8606398290" class="cta-btn">📞 Call PT — (860) 639-8290</a>
    <div class="sig"><div class="avatar">PT</div><div><div class="sig-name">Paul Terwilliger</div><div class="sig-title">Mortgage Broker · Barrett Financial Group</div><div class="sig-contact">(860) 639-8290 · NMLS #321929</div></div></div>
  </div>
</div>
<img src="/api/track/${sendId || videoId}" width="1" height="1" style="display:none">
</body></html>`;
}

app.listen(PORT, () => console.log(`✅ Team Prime Time Video running on port ${PORT}`));
