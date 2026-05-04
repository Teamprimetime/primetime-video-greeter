# Team Prime Time — Video Greeter
### Deployment Guide — DigitalOcean Setup

---

## What This Is
A BombBomb-style video email platform for Paul "PT" Terwilliger.
- Record webcam videos
- Send personalized video emails to realtor contacts
- Track who watched
- Branded Team Prime Time landing pages

---

## What PT Did
PT signed up for a $6/month DigitalOcean Droplet.
He will send you his DigitalOcean login.
Your job: deploy this app and point video.teamprimetimeloans.com to it.

---

## Step 1 — Create the Droplet in DigitalOcean

1. Log into digitalocean.com with PT's credentials
2. Click **Create → Droplets**
3. Settings:
   - **Region:** New York (closest to CT)
   - **Image:** Ubuntu 22.04 LTS
   - **Size:** Basic → Regular → **$6/month** (1GB RAM)
   - **Authentication:** Add your SSH key or use a password
4. Click **Create Droplet**
5. Copy the Droplet IP address (e.g. 123.45.67.89)

---

## Step 2 — Point Subdomain in Cloudflare

In PT's Cloudflare account for teamprimetimeloans.com:
1. Go to DNS
2. Add new record:
   - **Type:** A
   - **Name:** video
   - **Value:** (Droplet IP from Step 1)
   - **Proxy:** DNS Only (gray cloud)
3. Save

---

## Step 3 — SSH In & Set Up the Server

```bash
ssh root@YOUR_DROPLET_IP

# Update server
apt update && apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Install nginx
apt install -y nginx

# Create app directory
mkdir -p /var/www/primetime-video
```

---

## Step 4 — Upload the App

From your local machine:
```bash
scp -r primetime-video/ root@YOUR_DROPLET_IP:/var/www/primetime-video
```
Or use FileZilla (free) to drag and drop the folder.

---

## Step 5 — Install Dependencies

```bash
cd /var/www/primetime-video
npm install
```

---

## Step 6 — Run as a Service

```bash
nano /etc/systemd/system/primetime.service
```

Paste this:
```ini
[Unit]
Description=Team Prime Time Video Greeter
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/var/www/primetime-video
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
Environment=PORT=3000
Environment=BASE_URL=https://video.teamprimetimeloans.com

[Install]
WantedBy=multi-user.target
```

Save (Ctrl+X → Y → Enter), then:
```bash
systemctl enable primetime
systemctl start primetime
```

---

## Step 7 — Configure Nginx

```bash
nano /etc/nginx/sites-available/primetime
```

Paste this:
```nginx
server {
    listen 80;
    server_name video.teamprimetimeloans.com;
    client_max_body_size 200M;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Then:
```bash
ln -s /etc/nginx/sites-available/primetime /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx
```

---

## Step 8 — Free SSL Certificate

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d video.teamprimetimeloans.com
```

Follow the prompts. Auto-renews. Done.

---

## Step 9 — Test It

Open: **https://video.teamprimetimeloans.com**
You should see the Team Prime Time Video Greeter. 🎉

---

## Useful Commands

```bash
systemctl status primetime    # Is it running?
systemctl restart primetime   # Restart app
journalctl -u primetime -f    # View logs
systemctl restart nginx       # Restart nginx
```

---

## Email Setup for PT
PT can use his own email (paul@teamprimetimeloans.com) to send videos.
He just needs to enter credentials in the Settings page of the app.

For Gmail/Google Workspace, he'll need an App Password:
1. Go to Google Account → Security
2. Enable 2-Step Verification
3. Go to App Passwords → generate one
4. Enter that password in the app Settings

---

## File Structure
```
primetime-video/
├── server/
│   └── index.js          ← Main server
├── public/
│   ├── index.html         ← Home dashboard
│   ├── css/main.css       ← Styles
│   └── pages/
│       ├── record.html    ← Record & Send
│       ├── contacts.html  ← Realtor list
│       ├── dashboard.html ← View tracking
│       └── settings.html  ← Email config
├── database/              ← Auto-created, SQLite DB lives here
├── uploads/               ← Auto-created, videos stored here
└── package.json
```

---

## Questions?
The app runs on Express + SQLite + Multer. No external services needed.
Videos are stored locally in /uploads. Database is SQLite in /database.

PT's contact: (860) 639-8290
