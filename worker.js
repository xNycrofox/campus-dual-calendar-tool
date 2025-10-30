export default {
  async fetch(req) {
    // --- CORS nur für Browser wichtig ---
    const origin = req.headers.get('Origin') || '';
    const corsHeaders = {
      'Access-Control-Allow-Origin': origin || 'https://xnycrofox.github.io',
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': req.headers.get('Access-Control-Request-Headers') || 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    const url = new URL(req.url);
    const p = url.searchParams;
    const debug = p.get('debug') === '1';
    const uid = p.get('u');
    const hash = p.get('h');
    const months = Number(p.get('m') || 3);
    if (!uid || !hash)
      return new Response('Fehler: Es fehlen Parameter (userid oder hash).', {
        status: 400,
        headers: corsHeaders,
      });

    const now = Math.floor(Date.now() / 1000);
    const start = now - 60 * 60 * 24 * 14; // 14 Tage zurück
    const end = now + 60 * 60 * 24 * 30 * months; // m Monate vor
    const api = `https://selfservice.campus-dual.de/room/json?userid=${uid}&hash=${hash}&start=${start}&end=${end}&_=${Date.now()}`;

    const upstream = await fetch(api, {
      redirect: 'manual',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Referer': 'https://selfservice.campus-dual.de/',
        'Origin': 'https://selfservice.campus-dual.de',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });

    async function dumpResponse(res) {
      const headersObj = {};
      for (const [k, v] of res.headers) headersObj[k] = v;
      let bodyText = '';
      try {
        bodyText = await res.text();
      } catch {
        bodyText = '<non-text body>';
      }
      const dump = {
        requested_url: api,
        status: res.status,
        headers: headersObj,
        body_preview: bodyText.slice(0, 400),
      };
      console.log('UPSTREAM_DUMP', dump);
      return JSON.stringify(dump, null, 2);
    }

    // ---- Fehlerbehandlung mit Hinweis für Nutzer ----
    if (upstream.status >= 300 && upstream.status < 400) {
      const dump = await dumpResponse(upstream);
      const msg =
        'Der Campus-Dual-Server leitet die Anfrage derzeit um oder verlangt eine Anmeldung. Bitte versuche es später erneut.';
      return new Response(debug ? dump : msg, {
        status: 503,
        headers: {
          'Content-Type': debug ? 'application/json' : 'text/plain; charset=utf-8',
          ...corsHeaders,
        },
      });
    }

    if (upstream.status === 526) {
      const dump = await dumpResponse(upstream);
      const msg =
        'Der Campus-Dual-Server hat aktuell ein technisches Problem mit seinem SSL-Zertifikat. Dadurch kann keine Verbindung hergestellt werden. Bitte wende dich bei Bedarf an die IT der Hochschule.';
      return new Response(debug ? dump : msg, {
        status: 503,
        headers: {
          'Content-Type': debug ? 'application/json' : 'text/plain; charset=utf-8',
          ...corsHeaders,
        },
      });
    }

    if (!upstream.ok) {
      const dump = await dumpResponse(upstream);
      const msg =
        'Der Campus-Dual-Server ist momentan nicht erreichbar oder antwortet fehlerhaft. Das Problem liegt auf Seiten von Campus Dual.';
      return new Response(debug ? dump : msg, {
        status: 503,
        headers: {
          'Content-Type': debug ? 'application/json' : 'text/plain; charset=utf-8',
          ...corsHeaders,
        },
      });
    }

    // ---- Versuch, JSON zu parsen ----
    let rows;
    try {
      rows = await upstream.json();
    } catch {
      const dump = await dumpResponse(upstream);
      const msg =
        'Campus Dual hat eine unerwartete Antwort gesendet (kein gültiges JSON). Das Problem liegt auf dem Server von Campus Dual.';
      return new Response(debug ? dump : msg, {
        status: 502,
        headers: {
          'Content-Type': debug ? 'application/json' : 'text/plain; charset=utf-8',
          ...corsHeaders,
        },
      });
    }

    // ---- ICS bauen ----
    const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const esc = (s) =>
      String(s)
        .replace(/\\/g, '\\\\')
        .replace(/[,;]/g, (m) => '\\' + m)
        .replace(/\r?\n/g, '\\n');

    const nowIso = fmt(new Date());
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//campus-dual//worker//EN',
      ...rows.flatMap((row, i) => {
        const dtStart = fmt(new Date(row.start * 1000));
        const dtEnd = fmt(new Date(row.end * 1000));
        const lines = [
          'BEGIN:VEVENT',
          `UID:${uid}-${row.id ?? i}@campus`,
          `DTSTAMP:${nowIso}`,
          `DTSTART:${dtStart}`,
          `DTEND:${dtEnd}`,
          `SUMMARY:${esc(row.text || row.title || 'Unterricht')}`,
        ];
        if (row.room) lines.push(`LOCATION:${esc(row.room)}`);
        const desc = [row.course, row.teacher].filter(Boolean).join(' – ');
        if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
        lines.push('END:VEVENT');
        return lines;
      }),
      'END:VCALENDAR',
    ].join('\r\n');

    return new Response(ics, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Cache-Control': 'public, max-age=900',
        ...corsHeaders,
      },
    });
  },
};
