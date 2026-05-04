const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const sqlite3 = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Setup
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Database
const db = sqlite3(path.join(__dirname, '../database/primetime.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS realtors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    company TEXT,
    phone TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    title TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    realtor_id INTEGER NOT NULL,
    realtor_name TEXT,
    realtor_email TEXT,
    message TEXT,
    subject TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    viewed INTEGER DEFAULT 0,
    viewed_at DATETIME,
    view_count INTEGER DEFAULT 0
  );
`);

// Video upload storage
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const id = uuidv4();
    cb(null, `${id}.webm`);
  }
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// ─── ROUTES ───────────────────────────────────────────────

// Upload video
app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const id = path.parse(req.file.filename).name;
  db.prepare('INSERT INTO videos (id, filename, title) VALUES (?, ?, ?)').run(id, req.file.filename, req.body.title || 'Monday Greeting');
  res.json({ id, url: `/watch/${id}` });
});

// Get all realtors
app.get('/api/realtors', (req, res) => {
  const realtors = db.prepare('SELECT * FROM realtors ORDER BY name ASC').all();
  res.json(realtors);
});

// Add realtor
app.post('/api/realtors', (req, res) => {
  const { name, email, company, phone } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  try {
    const result = db.prepare('INSERT INTO realtors (name, email, company, phone) VALUES (?, ?, ?, ?)').run(name, email, company || '', phone || '');
    res.json({ id: result.lastInsertRowid, name, email, company, phone });
  } catch (e) {
    res.status(400).json({ error: 'Email already exists' });
  }
});

// Delete realtor
app.delete('/api/realtors/:id', (req, res) => {
  db.prepare('DELETE FROM realtors WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Send video emails
app.post('/api/send', async (req, res) => {
  const { videoId, realtorIds, subject, message, senderEmail, senderPassword, senderHost, senderPort } = req.body;
  
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  if (!video) return res.status(404).json({ error: 'Video not found' });

  const realtors = realtorIds.map(id => db.prepare('SELECT * FROM realtors WHERE id = ?').get(id)).filter(Boolean);
  if (!realtors.length) return res.status(400).json({ error: 'No valid realtors' });

  // Save send records
  const sendRecords = realtors.map(r => {
    const personalMsg = message.replace(/{name}/g, r.name.split(' ')[0]);
    const stmt = db.prepare('INSERT INTO sends (video_id, realtor_id, realtor_name, realtor_email, message, subject) VALUES (?, ?, ?, ?, ?, ?)');
    const result = stmt.run(videoId, r.id, r.name, r.email, personalMsg, subject);
    return { sendId: result.lastInsertRowid, realtor: r, message: personalMsg };
  });

  // If email credentials provided, send actual emails
  if (senderEmail && senderPassword) {
    try {
      const transporter = nodemailer.createTransport({
        host: senderHost || 'smtp.gmail.com',
        port: senderPort || 587,
        secure: false,
        auth: { user: senderEmail, pass: senderPassword }
      });

      const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;

      for (const { sendId, realtor, message: personalMsg } of sendRecords) {
        const watchUrl = `${baseUrl}/watch/${videoId}?sid=${sendId}`;
        const firstName = realtor.name.split(' ')[0];

        const html = generateEmailHTML(firstName, personalMsg, watchUrl, videoId, baseUrl);
        await transporter.sendMail({
          from: `"Paul PT Terwilliger - Team Prime Time" <${senderEmail}>`,
          to: realtor.email,
          subject: subject.replace(/{name}/g, firstName),
          html
        });
      }
      res.json({ success: true, sent: realtors.length, mode: 'email' });
    } catch (e) {
      res.json({ success: true, sent: realtors.length, mode: 'preview', error: e.message });
    }
  } else {
    res.json({ success: true, sent: realtors.length, mode: 'preview', sendRecords });
  }
});

// Track video view
app.get('/api/track/:sendId', (req, res) => {
  const send = db.prepare('SELECT * FROM sends WHERE id = ?').get(req.params.sendId);
  if (send) {
    db.prepare('UPDATE sends SET viewed = 1, view_count = view_count + 1, viewed_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.sendId);
  }
  // Return 1x1 transparent pixel
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': pixel.length });
  res.end(pixel);
});

// Get dashboard stats
app.get('/api/stats', (req, res) => {
  const totalSent = db.prepare('SELECT COUNT(*) as count FROM sends').get().count;
  const totalViewed = db.prepare('SELECT COUNT(*) as count FROM sends WHERE viewed = 1').get().count;
  const recentSends = db.prepare(`
    SELECT s.*, v.title as video_title 
    FROM sends s 
    LEFT JOIN videos v ON s.video_id = v.id 
    ORDER BY s.sent_at DESC LIMIT 20
  `).all();
  const realtorCount = db.prepare('SELECT COUNT(*) as count FROM realtors').get().count;
  res.json({ totalSent, totalViewed, recentSends, realtorCount });
});

// Serve video file
app.get('/uploads/:filename', (req, res) => {
  const filePath = path.join(uploadsDir, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// Watch page
app.get('/watch/:videoId', (req, res) => {
  const { videoId, sid } = req.query.sid ? req.query : { videoId: req.params.videoId };
  const id = req.params.videoId;
  const sendId = req.query.sid;
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
  if (!video) return res.status(404).send('Video not found');
  
  let realtorName = '';
  if (sendId) {
    const send = db.prepare('SELECT * FROM sends WHERE id = ?').get(sendId);
    if (send) realtorName = send.realtor_name;
  }

  res.send(generateWatchPage(id, video.filename, realtorName, sendId));
});

// Serve main app pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('/record', (req, res) => res.sendFile(path.join(__dirname, '../public/pages/record.html')));
app.get('/contacts', (req, res) => res.sendFile(path.join(__dirname, '../public/pages/contacts.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../public/pages/dashboard.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, '../public/pages/settings.html')));

// ─── HTML GENERATORS ──────────────────────────────────────

function generateEmailHTML(firstName, message, watchUrl, videoId, baseUrl) {
  const trackPixel = `${baseUrl}/api/track/${videoId}`;
  const msgHtml = message.replace(/\n/g, '<br>');
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:'Georgia',serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:30px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:600px">
  <tr><td style="background:#0d1b2a;padding:24px 32px;text-align:center">
    <div style="font-family:Georgia,serif;font-size:22px;font-weight:bold;color:#c9a84c">Team Prime Time Loans</div>
    <div style="font-size:11px;color:rgba(255,255,255,0.5);letter-spacing:2px;text-transform:uppercase;margin-top:4px">Paul "PT" Terwilliger · NMLS #321929</div>
  </td></tr>
  <tr><td style="padding:32px">
    <p style="font-size:16px;color:#0d1b2a;margin:0 0 24px">Hey ${firstName},</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      <tr><td>
        <a href="${watchUrl}" style="display:block;text-decoration:none;border-radius:10px;overflow:hidden;position:relative">
          <div style="background:#0d1b2a;border-radius:10px;padding:60px 20px;text-align:center">
            <div style="width:64px;height:64px;background:#c9a84c;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:12px">▶</div>
            <div style="font-family:Georgia,serif;font-size:18px;color:#c9a84c;font-weight:bold">Good morning, ${firstName}!</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.5);letter-spacing:1px;text-transform:uppercase;margin-top:4px">Click to watch PT's message</div>
          </div>
        </a>
      </td></tr>
    </table>
    <div style="font-size:15px;line-height:1.7;color:#333;margin-bottom:28px">${msgHtml}</div>
    <table cellpadding="0" cellspacing="0" style="border-top:2px solid #c9a84c;padding-top:20px;width:100%">
      <tr>
        <td style="width:52px;height:52px;background:#0d1b2a;border-radius:50%;text-align:center;vertical-align:middle;font-family:Georgia,serif;font-size:20px;color:#c9a84c;font-weight:bold">PT</td>
        <td style="padding-left:14px;vertical-align:middle">
          <div style="font-weight:bold;font-size:15px;color:#0d1b2a">Paul "PT" Terwilliger</div>
          <div style="font-size:12px;color:#666">Mortgage Broker · Barrett Financial Group</div>
          <div style="font-size:12px;color:#c9a84c;font-weight:bold">(860) 639-8290 · TeamPrimeTimeLoans.com</div>
          <div style="font-size:11px;color:#999">NMLS #321929</div>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</td></tr>
</table>
<img src="${trackPixel}" width="1" height="1" style="display:none">
</body></html>`;
}

function generateWatchPage(videoId, filename, realtorName, sendId) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Message from PT — Team Prime Time Loans</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=DM+Sans:wght@300;400;600&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1b2a;color:#f8f5ef;font-family:'DM Sans',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}
.card{background:#162236;border-radius:20px;overflow:hidden;max-width:640px;width:100%;box-shadow:0 40px 80px rgba(0,0,0,0.5)}
.card-header{background:#0d1b2a;padding:20px 28px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(201,168,76,0.2)}
.brand{font-family:'Playfair Display',serif;font-size:18px;color:#c9a84c;font-weight:900}
.brand-sub{font-size:10px;color:rgba(255,255,255,0.4);letter-spacing:2px;text-transform:uppercase}
.video-wrap{position:relative;background:#000;aspect-ratio:16/9}
video{width:100%;height:100%;object-fit:cover;display:block}
.card-body{padding:28px}
.greeting{font-family:'Playfair Display',serif;font-size:22px;color:#c9a84c;margin-bottom:8px}
.sub{font-size:13px;color:rgba(255,255,255,0.5);margin-bottom:24px}
.cta-btn{display:block;width:100%;padding:16px;background:linear-gradient(135deg,#c9a84c,#e8c96a);color:#0d1b2a;font-weight:700;font-size:15px;text-align:center;border-radius:10px;text-decoration:none;margin-bottom:12px;font-family:'DM Sans',sans-serif}
.cta-secondary{display:block;width:100%;padding:14px;background:transparent;color:#c9a84c;font-weight:600;font-size:14px;text-align:center;border-radius:10px;text-decoration:none;border:1px solid rgba(201,168,76,0.3);font-family:'DM Sans',sans-serif}
.sig{display:flex;align-items:center;gap:14px;margin-top:24px;padding-top:20px;border-top:1px solid rgba(201,168,76,0.2)}
.avatar{width:48px;height:48px;background:#0d1b2a;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:'Playfair Display',serif;font-size:18px;color:#c9a84c;font-weight:900;flex-shrink:0}
.sig-name{font-weight:700;font-size:14px}
.sig-title{font-size:12px;color:rgba(255,255,255,0.5)}
.sig-contact{font-size:12px;color:#c9a84c;font-weight:600}
</style>
</head>
<body>
<div class="card">
  <div class="card-header">
    <div>
      <div class="brand">Team Prime Time Loans</div>
      <div class="brand-sub">Paul "PT" Terwilliger · NMLS #321929</div>
    </div>
  </div>
  <div class="video-wrap">
    <video controls autoplay playsinline src="/uploads/${filename}"></video>
  </div>
  <div class="card-body">
    <div class="greeting">Good morning${realtorName ? ', ' + realtorName.split(' ')[0] : ''}! 👋</div>
    <div class="sub">A personal message from your mortgage guy, PT</div>
    <a href="tel:8606398290" class="cta-btn">📞 Call PT — (860) 639-8290</a>
    <a href="https://teamprimetimeloans.com" class="cta-secondary" target="_blank">Visit TeamPrimeTimeLoans.com</a>
    <div class="sig">
      <div class="avatar">PT</div>
      <div>
        <div class="sig-name">Paul "PT" Terwilliger</div>
        <div class="sig-title">Mortgage Broker · Barrett Financial Group</div>
        <div class="sig-contact">(860) 639-8290 · NMLS #321929</div>
      </div>
    </div>
  </div>
</div>
</body>
</html>`;
}

app.listen(PORT, () => console.log(`✅ Team Prime Time Video running on port ${PORT}`));
