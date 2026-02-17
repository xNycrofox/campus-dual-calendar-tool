/* eslint-disable no-control-regex */

// --- KONFIG ---
const ALLOWED_ORIGIN = "https://xnycrofox.github.io";

// Kalender-Clients (User-Agent Heuristik, nicht “Security”!)
const ALLOWED_AGENTS =
  /Google-Calendar|Microsoft|Outlook|Apple-PubSub|iOS|Mac OS X|Android|Thunderbird|Java\/|Feed|vCalendar|iCal/i;

// Upstream
const CAMPUS_BASE = "https://selfservice.campus-dual.de";
const UPSTREAM_PATH = "/room/json";

// Retry-Statuscodes (transient / edge-origin-issues)
const RETRY_STATUSES = new Set([520, 522, 523, 524, 526]);

// ---- Hilfsfunktionen ----

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// CORS: nur für Browser relevant
function buildCorsHeaders(req) {
  const origin = req.headers.origin || "";
  const allowed =
    origin === ALLOWED_ORIGIN || origin.includes("localhost") ? origin : ALLOWED_ORIGIN;

  return {
    "Access-Control-Allow-Origin": allowed,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

// Heuristik: nur Webseite oder Kalenderclient darf
function gatekeeper(req) {
  const origin = (req.headers.origin || req.headers.referer || "").toLowerCase();
  const ua = (req.headers["user-agent"] || "").toLowerCase();

  const isMyWebsite =
    origin.includes("xnycrofox.github.io") || origin.includes("localhost");
  const isCalendarClient = ALLOWED_AGENTS.test(req.headers["user-agent"] || "");

  return { isMyWebsite, isCalendarClient, uaRaw: req.headers["user-agent"] || "" };
}

// Dump: Debug-Ausgabe bei upstream-Fehlern
async function dumpUpstream(response, requestedUrl) {
  const headersObj = {};
  for (const [k, v] of response.headers.entries()) headersObj[k] = v;

  let bodyPreview = "";
  try {
    const buf = Buffer.from(await response.arrayBuffer());
    // body preview in utf8, falls html error page etc.
    bodyPreview = buf.toString("utf8").slice(0, 800);
  } catch {
    bodyPreview = "<non-text body>";
  }

  return {
    requested_url: requestedUrl,
    status: response.status,
    status_text: response.statusText,
    headers: headersObj,
    body_preview: bodyPreview
  };
}

// Fetch mit Retry bei 52x/526 oder Netzwerkfehlern
async function fetchWithRetry(url, init, tries = 3) {
  let lastErr = null;

  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;

      // bei Redirects oder non-transient direkt raus
      if (res.status >= 300 && res.status < 400) return res;
      if (!RETRY_STATUSES.has(res.status)) return res;

      // transient -> retry
      await sleep(150 * (i + 1));
      continue;
    } catch (err) {
      lastErr = err;
      await sleep(150 * (i + 1));
    }
  }

  // Letzter Versuch ohne swallow
  if (lastErr) throw lastErr;
  return fetch(url, init);
}

// JSON robust parsen (utf8 -> fallback latin1)
async function parseJsonRobust(response) {
  const buf = Buffer.from(await response.arrayBuffer());

  // 1) utf8 versuchen
  try {
    const t = buf.toString("utf8");
    return JSON.parse(t);
  } catch {}

  // 2) latin1 fallback (wenn server JSON in latin1 liefert)
  const t2 = buf.toString("latin1");
  return JSON.parse(t2);
}

// Mojibake-Fix: "HÃ¤nel" -> "Hänel" (nur wenn typisch kaputt)
function fixMojibake(s) {
  if (s == null) return s;
  const str = String(s);

  // Heuristik: nur anfassen, wenn typische Zeichen vorkommen
  if (!/[ÃÂ�]/.test(str)) return str;

  try {
    return Buffer.from(str, "latin1").toString("utf8");
  } catch {
    return str;
  }
}

// RFC5545 escaping
function icsEscape(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// Format YYYYMMDDTHHMMSS (lokal, ohne Z)
function fmtLocal(dt) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    dt.getFullYear() +
    pad(dt.getMonth() + 1) +
    pad(dt.getDate()) +
    "T" +
    pad(dt.getHours()) +
    pad(dt.getMinutes()) +
    pad(dt.getSeconds())
  );
}

// Format UTC YYYYMMDDTHHMMSSZ
function fmtUtc(dt) {
  return dt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

// Zeilenfaltung (max 75 OCTETS) – Outlook mag das
function foldIcs(icsText) {
  const lines = icsText.split("\r\n");
  const out = [];

  for (const line of lines) {
    // already empty or short
    if (Buffer.byteLength(line, "utf8") <= 75) {
      out.push(line);
      continue;
    }

    // fold by bytes, inserting CRLF + space
    const bytes = Buffer.from(line, "utf8");
    let start = 0;
    let first = true;

    while (start < bytes.length) {
      const chunk = bytes.slice(start, start + 75);
      const str = chunk.toString("utf8");
      out.push((first ? "" : " ") + str);
      first = false;
      start += 75;
    }
  }

  return out.join("\r\n");
}

// Stabile UID
function makeUid(uid, row) {
  const title = fixMojibake(row.title || row.text || "Unterricht");
  const slug = title.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24) || "event";
  return `${uid}-${row.start}-${row.end}-${slug}@campus-dual`;
}

// VTIMEZONE für Europe/Berlin (DST-Regeln)
function vTimezoneEuropeBerlin() {
  return [
    "BEGIN:VTIMEZONE",
    "TZID:Europe/Berlin",
    "X-LIC-LOCATION:Europe/Berlin",
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:+0100",
    "TZOFFSETTO:+0200",
    "TZNAME:CEST",
    "DTSTART:19700329T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:+0200",
    "TZOFFSETTO:+0100",
    "TZNAME:CET",
    "DTSTART:19701025T030000",
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
    "END:STANDARD",
    "END:VTIMEZONE"
  ];
}

// ---- Handler ----
module.exports = async (req, res) => {
  const corsHeaders = buildCorsHeaders(req);

  // Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    return res.end();
  }

  // Nur GET
  if (req.method !== "GET") {
    res.writeHead(405, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Method Not Allowed");
  }

  const debug = req.query.debug === "1";
  const uid = req.query.u;
  const hash = req.query.h;
  const months = Number(req.query.m || 3);

  // Gatekeeper (optional, aber du wolltest es so)
  const gate = gatekeeper(req);
  if (!gate.isMyWebsite && !gate.isCalendarClient) {
    res.writeHead(403, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
    return res.end(
      `Zugriff verweigert.\nDieser Feed ist nur über deine Webseite oder über Kalender-Apps gedacht.\n\nUser-Agent: ${gate.uaRaw}`
    );
  }

  if (!uid || !hash) {
    res.writeHead(400, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Fehler: userid (u) und hash (h) fehlen.");
  }

  // Zeitfenster
  const now = Math.floor(Date.now() / 1000);
  const start = now - 60 * 60 * 24 * 14;
  const end = now + 60 * 60 * 24 * 30 * (Number.isFinite(months) ? months : 3);

  // Cache-buster
  const apiToken = Date.now();
  const requestedUrl =
    `${CAMPUS_BASE}${UPSTREAM_PATH}` +
    `?userid=${encodeURIComponent(uid)}` +
    `&hash=${encodeURIComponent(hash)}` +
    `&start=${start}&end=${end}&_=${apiToken}`;

  // Upstream fetch
  let upstream;
  try {
    upstream = await fetchWithRetry(
      requestedUrl,
      {
        redirect: "manual",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
          "User-Agent": "Mozilla/5.0 (CampusDualICS/1.0; Vercel)",
          "Referer": `${CAMPUS_BASE}/`,
          "Origin": CAMPUS_BASE,
          "X-Requested-With": "XMLHttpRequest"
        }
      },
      3
    );
  } catch (err) {
    res.writeHead(502, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
    return res.end(`Fehler: Upstream-Fetch fehlgeschlagen: ${err.message}`);
  }

  // Redirects (Login / WAF)
  if (upstream.status >= 300 && upstream.status < 400) {
    const dump = debug ? await dumpUpstream(upstream, requestedUrl) : null;

    res.writeHead(503, { ...corsHeaders, "Content-Type": debug ? "application/json" : "text/plain; charset=utf-8" });
    return res.end(
      debug
        ? JSON.stringify(dump, null, 2)
        : "Der Campus-Dual-Server leitet um oder verlangt eine Anmeldung. Bitte später erneut versuchen."
    );
  }

  // 526 (Cloudflare Origin SSL)
  if (upstream.status === 526) {
    const dump = debug ? await dumpUpstream(upstream, requestedUrl) : null;

    res.writeHead(503, { ...corsHeaders, "Content-Type": debug ? "application/json" : "text/plain; charset=utf-8" });
    return res.end(
      debug
        ? JSON.stringify(dump, null, 2)
        : "Campus Dual hat aktuell ein SSL/Origin-Problem (526). Das liegt sehr wahrscheinlich an deren Infrastruktur. Bitte später erneut versuchen."
    );
  }

  // Andere Errors
  if (!upstream.ok) {
    const dump = debug ? await dumpUpstream(upstream, requestedUrl) : null;

    res.writeHead(503, { ...corsHeaders, "Content-Type": debug ? "application/json" : "text/plain; charset=utf-8" });
    return res.end(
      debug
        ? JSON.stringify(dump, null, 2)
        : "Campus Dual ist momentan nicht erreichbar oder antwortet fehlerhaft."
    );
  }

  // JSON parse
  let rows;
  try {
    rows = await parseJsonRobust(upstream);
  } catch (err) {
    res.writeHead(502, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
    return res.end(`Fehler: Ungültige JSON-Antwort von Campus Dual: ${err.message}`);
  }

  if (!Array.isArray(rows)) {
    res.writeHead(502, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Fehler: Formatfehler – kein Array empfangen.");
  }

  // ---- ICS bauen (Outlook-friendly) ----
  const nowUtc = fmtUtc(new Date());

  const calLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Vercel//CampusDualICS//DE",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Campus Dual",
    "X-WR-TIMEZONE:Europe/Berlin",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ...vTimezoneEuropeBerlin()
  ];

  for (const row of rows) {
    if (!row || !row.start || !row.end) continue;

    const title = fixMojibake(row.title || row.text || "Vorlesung");
    const instructor = fixMojibake(row.instructor || row.sinstructor || "");
    const room = fixMojibake(row.room || row.sroom || "");
    const description = fixMojibake(row.description || "");
    const remarks = fixMojibake(row.remarks || "");

    const dtStart = new Date(row.start * 1000);
    const dtEnd = new Date(row.end * 1000);

    // Beschreibung sauber zusammensetzen
    const descParts = [];
    if (description && description !== title) descParts.push(description);
    if (instructor && instructor.trim()) descParts.push(`Dozent: ${instructor}`);
    if (remarks && remarks.trim()) descParts.push(`Bemerkung: ${remarks}`);
    const fullDesc = descParts.join("\n");

    calLines.push("BEGIN:VEVENT");
    calLines.push(`UID:${makeUid(uid, row)}`);
    calLines.push(`DTSTAMP:${nowUtc}`);

    // Lokalzeit mit TZID (besser für Outlook, sonst Verschiebungen)
    calLines.push(`DTSTART;TZID=Europe/Berlin:${fmtLocal(dtStart)}`);
    calLines.push(`DTEND;TZID=Europe/Berlin:${fmtLocal(dtEnd)}`);

    calLines.push(`SUMMARY:${icsEscape(title)}`);
    calLines.push("STATUS:CONFIRMED");
    calLines.push("SEQUENCE:0");

    if (room && room !== "---" && room !== "Ohne") {
      calLines.push(`LOCATION:${icsEscape(room)}`);
    }

    if (fullDesc) {
      calLines.push(`DESCRIPTION:${icsEscape(fullDesc)}`);
    }

    calLines.push("END:VEVENT");
  }

  calLines.push("END:VCALENDAR");

  // Join + fold
  const icsRaw = calLines.join("\r\n");
  const ics = foldIcs(icsRaw);

  // Antwort
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", 'inline; filename="campus-dual.ics"');

  // Caching: Kalender-Clients cachen aggressiv, 15 min ist okay (wie bei dir)
  res.setHeader("Cache-Control", "public, max-age=900, s-maxage=900");

  // CORS
  for (const [k, v] of Object.entries(corsHeaders)) res.setHeader(k, v);

  return res.end(ics);
};
