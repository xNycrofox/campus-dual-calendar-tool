import fetch from 'node-fetch';
import https from 'https';

// --- KONFIGURATION ---
// Hier trägst du deine GitHub Page ein (ohne Slash am Ende)
const ALLOWED_ORIGIN = 'https://xnycrofox.github.io';

// Liste der erlaubten Kalender-Clients (Regex)
// Erlaubt: Google, Outlook, Apple, Android, Thunderbird, etc.
const ALLOWED_AGENTS = /Google-Calendar|Microsoft|Outlook|Apple-PubSub|iOS|Mac OS X|Android|Thunderbird|Java\/|Feed|vCalendar|iCal/i;

// Agent für unsichere Verbindung zu Campus Dual
const unsafeAgent = new https.Agent({
  rejectUnauthorized: false
});

export default async function handler(req, res) {
  const { u: uid, h: hash, m } = req.query;

  // --- 1. SICHERHEITS-CHECK (Gatekeeper) ---
  
  const origin = req.headers['origin'] || req.headers['referer'] || '';
  const userAgent = req.headers['user-agent'] || '';
  
  // Prüfen, ob Anfrage von deiner Webseite kommt
  const isMyWebsite = origin.includes('xnycrofox.github.io') || origin.includes('localhost'); // Localhost für Tests erlauben
  
  // Prüfen, ob es ein Kalender-Programm ist
  const isCalendarClient = ALLOWED_AGENTS.test(userAgent);

  // WICHTIG: Wenn es weder deine Webseite noch ein Kalender ist -> BLOCKIEREN
  if (!isMyWebsite && !isCalendarClient) {
    return res.status(403).send(`
      Zugriff verweigert. 
      Dieser Kalender-Feed ist nur für Kalender-Apps (Outlook, Google, Apple) 
      oder über die offizielle Webseite verfügbar.
      Dein Client: ${userAgent}
    `);
  }

  // --- 2. PARAMETER CHECK ---
  if (!uid || !hash) {
    return res.status(400).send('Fehler: userid (u) und hash (h) fehlen.');
  }

  // CORS Header: Nur deiner Webseite erlauben, den Request via JS zu machen
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  // --- 3. CAMPUS DUAL ABRUF ---
  const months = Number(m || 3);
  const now = Math.floor(Date.now() / 1000);
  const start = now - 60 * 60 * 24 * 14; 
  const end = now + 60 * 60 * 24 * 30 * months; 

  // Cache-Buster, damit wir immer frische Daten kriegen
  const apiToken = Date.now(); 
  const url = `https://selfservice.campus-dual.de/room/json?userid=${uid}&hash=${hash}&start=${start}&end=${end}&_=${apiToken}`;

  try {
    const response = await fetch(url, {
      agent: unsafeAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (CampusDualCal/Secure/1.0)',
        'Referer': 'https://selfservice.campus-dual.de/',
      }
    });

    if (!response.ok) throw new Error(`Campus Dual Status: ${response.status}`);

    let rows;
    try {
      rows = await response.json();
    } catch {
      throw new Error('Ungültige JSON-Antwort von Campus Dual.');
    }

    if (!Array.isArray(rows)) throw new Error('Format-Fehler: Kein Array empfangen.');

    // --- 4. ICS GENERIERUNG (Optimiert für Outlook) ---
    const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/[,;]/g, (m) => '\\' + m).replace(/\r?\n/g, '\\n');
    const fixText = (t) => {
        if (!t) return '';
        try { return decodeURIComponent(escape(t)); } catch { return t; }
    };

    const nowIso = fmt(new Date());

    const icsContent = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Vercel//CampusDualSecure//DE',
      'METHOD:PUBLISH', // Wichtig für Outlook Import
      'X-WR-CALNAME:Campus Dual Vorlesungen',
      'X-WR-TIMEZONE:Europe/Berlin',
      'CALSCALE:GREGORIAN',
      'REFRESH-INTERVAL;VALUE=DURATION:PT1H', // Apple & Google Update Rate
      'X-PUBLISHED-TTL:PT1H', // Outlook Update Rate Empfehlung
      ...rows.flatMap((row) => {
        if (!row.start || !row.end) return [];
        
        const title = fixText(row.title || row.text || 'Vorlesung');
        const instructor = fixText(row.instructor);
        const room = fixText(row.room);
        const description = fixText(row.description);
        const remarks = fixText(row.remarks);

        const descParts = [];
        if (description && description !== title) descParts.push(description);
        if (instructor) descParts.push(`Dozent: ${instructor}`);
        if (remarks) descParts.push(`Bemerkung: ${remarks}`);
        const fullDesc = descParts.join('\\n');

        // Stabile UID: Verhindert Duplikate in Outlook bei Updates
        const cleanTitle = title.replace(/[^a-zA-Z0-9]/g, '');
        const uniqueId = `${row.start}-${cleanTitle}-${uid}@campus-dual-proxy`;

        const lines = [
          'BEGIN:VEVENT',
          `UID:${uniqueId}`,
          `DTSTAMP:${nowIso}`,
          `DTSTART:${fmt(new Date(row.start * 1000))}`,
          `DTEND:${fmt(new Date(row.end * 1000))}`,
          `SUMMARY:${esc(title)}`,
          `STATUS:CONFIRMED`, // Hilft Outlook, den Termin ernst zu nehmen
          `SEQUENCE:0`
        ];

        if (room && room !== '---' && room !== 'Ohne') {
          lines.push(`LOCATION:${esc(room)}`);
        }
        
        if (fullDesc) {
          lines.push(`DESCRIPTION:${esc(fullDesc.replace(/\\n/g, '\n'))}`);
        }
        
        lines.push('END:VEVENT');
        return lines;
      }),
      'END:VCALENDAR'
    ].join('\r\n');

    // --- 5. ANTWORT SENDEN (Outlook-freundliche Header) ---
    
    // Content-Type zwingend korrekt setzen
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    // Zwingt Browser zum Download, Outlook frisst es aber trotzdem als Feed
    res.setHeader('Content-Disposition', 'inline; filename="campus.ics"');
    
    // Caching steuern: Outlook cached oft zu aggressiv. 
    // Wir sagen: "Darfst cachen, aber check jede Stunde (3600s) ob es was neues gibt"
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600'); 
    
    res.status(200).send(icsContent);

  } catch (err) {
    console.error(err);
    // Fehler als Text zurückgeben, damit man beim Debuggen nicht raten muss
    res.status(502).send(`Fehler: ${err.message}`);
  }
}