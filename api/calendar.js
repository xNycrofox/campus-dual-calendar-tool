/* eslint-disable no-control-regex */
const { request, Agent } = require("undici");

// ---------------- CONFIG ----------------
const ALLOWED_ORIGINS = new Set([
  "https://xnycrofox.github.io",
  "https://campus-dual-calendar-tool.vercel.app",
]);


const CAMPUS_BASE = "https://selfservice.campus-dual.de";
const UPSTREAM_PATH = "/room/json";

// transient edge/origin issues
const RETRY_STATUSES = new Set([520, 522, 523, 524, 526]);

// ---------------- HELPERS ----------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// CORS nur für Browser relevant
function buildCorsHeaders(req) {
  const origin = req.headers.origin || "";

  const allowed =
    ALLOWED_ORIGINS.has(origin) || origin.includes("localhost")
      ? origin
      : "https://xnycrofox.github.io";

  return {
    "Access-Control-Allow-Origin": allowed,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers":
      req.headers["access-control-request-headers"] || "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}


async function dumpUpstream(r, requestedUrl) {
  const bodyPreview = r?.buf ? r.buf.toString("utf8").slice(0, 800) : "<no body>";
  return {
    requested_url: requestedUrl,
    status: r?.status,
    headers: r?.headers,
    body_preview: bodyPreview,
  };
}

function parseJsonRobustFromBuf(buf) {
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {}
  return JSON.parse(buf.toString("latin1"));
}

// Mojibake-Fix: "HÃ¤nel" -> "Hänel"
function fixMojibake(s) {
  if (s == null) return s;
  const str = String(s);
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

// UTC timestamp for DTSTAMP
function fmtUtc(dt) {
  return dt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * WICHTIG: Date -> "YYYYMMDDTHHMMSS" in einer spezifischen Zeitzone (DST-safe)
 * Damit ist es egal, in welcher Zeitzone Vercel läuft.
 */
function fmtInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";

  return (
    get("year") +
    get("month") +
    get("day") +
    "T" +
    get("hour") +
    get("minute") +
    get("second")
  );
}

/**
 * Zeilenfaltung nach RFC (max 75 OCTETS pro Zeile).
 * Wichtig: an UTF-8-Grenzen sauber splitten (keine kaputten Umlaut-Bytes).
 */
function foldIcs(icsText) {
  const lines = icsText.split("\r\n");
  const out = [];

  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") <= 75) {
      out.push(line);
      continue;
    }

    let rest = line;
    let first = true;

    while (Buffer.byteLength(rest, "utf8") > 75) {
      // bestes Split-Index finden, sodass slice(0, idx) <= 75 bytes
      let idx = 1;
      let best = 1;

      // line-length ist klein genug, brute-force ist ok
      while (idx <= rest.length) {
        const part = rest.slice(0, idx);
        if (Buffer.byteLength(part, "utf8") <= 75) best = idx;
        else break;
        idx++;
      }

      const head = rest.slice(0, best);
      out.push((first ? "" : " ") + head);

      rest = rest.slice(best);
      first = false;
    }

    out.push((first ? "" : " ") + rest);
  }

  return out.join("\r\n");
}

function makeUid(uid, row) {
  const title = fixMojibake(row.title || row.text || "Unterricht");
  const slug = title.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24) || "event";
  return `${uid}-${row.start}-${row.end}-${slug}@campus-dual`;
}

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
    "END:VTIMEZONE",
  ];
}

// ---------------- UPSTREAM (undici) ----------------
// Hinweis: rejectUnauthorized:false ist “unsicher”, aber behebt oft TLS-Probleme bei kaputten Chains.
// Wenn es ohne geht: unbedingt auf true stellen!
const upstreamDispatcher = new Agent({
  connect: {
    rejectUnauthorized: false,
    servername: "selfservice.campus-dual.de",
  },
  allowH2: false,
  pipelining: 0,
});

async function undiciGet(url, headers) {
  const res = await request(url, {
    method: "GET",
    headers,
    dispatcher: upstreamDispatcher,
    maxRedirections: 0,
  });

  const chunks = [];
  for await (const chunk of res.body) chunks.push(chunk);
  const buf = Buffer.concat(chunks);

  return {
    status: res.statusCode,
    headers: res.headers,
    ok: res.statusCode >= 200 && res.statusCode < 300,
    buf,
  };
}

async function fetchWithRetry(url, headers, tries = 3) {
  let lastErr = null;

  for (let i = 0; i < tries; i++) {
    try {
      const r = await undiciGet(url, headers);

      if (r.ok) return r;
      if (r.status >= 300 && r.status < 400) return r; // redirect -> return
      if (!RETRY_STATUSES.has(r.status)) return r;      // not transient -> return

      await sleep(150 * (i + 1));
    } catch (err) {
      lastErr = err;
      await sleep(150 * (i + 1));
    }
  }

  if (lastErr) throw lastErr;
  return undiciGet(url, headers);
}

// ---------------- VERCEL HANDLER ----------------
module.exports = async (req, res) => {
  const corsHeaders = buildCorsHeaders(req);

  // Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    return res.end();
  }

  // Only GET
  if (req.method !== "GET") {
    res.writeHead(405, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Method Not Allowed");
  }

  const debug = req.query.debug === "1";
  const uid = req.query.u;
  const hash = req.query.h;
  const months = Number(req.query.m || 3);


  if (!uid || !hash) {
    res.writeHead(400, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Fehler: userid (u) und hash (h) fehlen.");
  }

  // Zeitfenster
  const now = Math.floor(Date.now() / 1000);
  const start = now - 60 * 60 * 24 * 14;
  const end = now + 60 * 60 * 24 * 30 * (Number.isFinite(months) ? months : 3);

  const requestedUrl =
    `${CAMPUS_BASE}${UPSTREAM_PATH}` +
    `?userid=${encodeURIComponent(uid)}` +
    `&hash=${encodeURIComponent(hash)}` +
    `&start=${start}&end=${end}&_=${Date.now()}`;

  // Upstream fetch
  let upstream;
  try {
    upstream = await fetchWithRetry(
      requestedUrl,
      {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
        "User-Agent": "Mozilla/5.0 (CampusDualICS/1.0; Vercel)",
        "Referer": `${CAMPUS_BASE}/`,
        "Origin": CAMPUS_BASE,
        "X-Requested-With": "XMLHttpRequest",
      },
      3
    );
  } catch (err) {
    const details = {
      message: err?.message,
      name: err?.name,
      code: err?.code,
      errno: err?.errno,
      syscall: err?.syscall,
      cause: err?.cause
        ? { message: err.cause.message, name: err.cause.name, code: err.cause.code }
        : undefined,
      stack: debug ? err?.stack : undefined,
      requested_url: requestedUrl,
    };

    res.writeHead(502, {
      ...corsHeaders,
      "Content-Type": debug ? "application/json" : "text/plain; charset=utf-8",
    });
    return res.end(
      debug ? JSON.stringify(details, null, 2) : `Fehler: Upstream-Fetch fehlgeschlagen: ${err.message}`
    );
  }

  // Redirect = Login / WAF / irgendwas
  if (upstream.status >= 300 && upstream.status < 400) {
    res.writeHead(503, {
      ...corsHeaders,
      "Content-Type": debug ? "application/json" : "text/plain; charset=utf-8",
    });
    return res.end(
      debug
        ? JSON.stringify(await dumpUpstream(upstream, requestedUrl), null, 2)
        : "Der Campus-Dual-Server leitet um oder verlangt eine Anmeldung. Bitte später erneut versuchen."
    );
  }

  if (!upstream.ok) {
    res.writeHead(503, {
      ...corsHeaders,
      "Content-Type": debug ? "application/json" : "text/plain; charset=utf-8",
    });
    return res.end(
      debug
        ? JSON.stringify(await dumpUpstream(upstream, requestedUrl), null, 2)
        : `Campus Dual ist momentan nicht erreichbar oder antwortet fehlerhaft (Status ${upstream.status}).`
    );
  }

  // JSON parse
  let rows;
  try {
    rows = parseJsonRobustFromBuf(upstream.buf);
  } catch (err) {
    res.writeHead(502, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
    return res.end(`Fehler: Ungültige JSON-Antwort von Campus Dual: ${err.message}`);
  }

  if (!Array.isArray(rows)) {
    res.writeHead(502, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Fehler: Formatfehler – kein Array empfangen.");
  }

  // ---------------- ICS BUILD (DST korrekt) ----------------
  const nowUtc = fmtUtc(new Date());
  const tz = "Europe/Berlin";

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
    ...vTimezoneEuropeBerlin(),
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

    // Beschreibung
    const descParts = [];
    if (description && description !== title) descParts.push(description);
    if (instructor && instructor.trim()) descParts.push(`Dozent: ${instructor}`);
    if (remarks && remarks.trim()) descParts.push(`Bemerkung: ${remarks}`);
    const fullDesc = descParts.join("\n");

    calLines.push("BEGIN:VEVENT");
    calLines.push(`UID:${makeUid(uid, row)}`);
    calLines.push(`DTSTAMP:${nowUtc}`);

    // >>> DAS ist der Fix: TZ-sicher formatieren (Sommer/Winterzeit korrekt)
    calLines.push(`DTSTART;TZID=${tz}:${fmtInTimeZone(dtStart, tz)}`);
    calLines.push(`DTEND;TZID=${tz}:${fmtInTimeZone(dtEnd, tz)}`);

    calLines.push(`SUMMARY:${icsEscape(title)}`);
    calLines.push("STATUS:CONFIRMED");
    calLines.push("SEQUENCE:0");

    if (room && room !== "---" && room !== "Ohne") calLines.push(`LOCATION:${icsEscape(room)}`);
    if (fullDesc) calLines.push(`DESCRIPTION:${icsEscape(fullDesc)}`);

    calLines.push("END:VEVENT");
  }

  calLines.push("END:VCALENDAR");

  const ics = foldIcs(calLines.join("\r\n"));

  // Response
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", 'inline; filename="campus-dual.ics"');
  res.setHeader("Cache-Control", "public, max-age=900, s-maxage=900");
  for (const [k, v] of Object.entries(corsHeaders)) res.setHeader(k, v);

  return res.end(ics);
};
