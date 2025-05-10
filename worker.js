export default {
    async fetch(req) {
      // CORS Headers
      const corsHeaders = {
        'Access-Control-Allow-Origin': 'https://xnycrofox.github.io',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      };
  
      // Handle OPTIONS request for CORS preflight
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          headers: corsHeaders,
        });
      }
  
      const { searchParams: p } = new URL(req.url);
      const uid = p.get('u');
      const hash = p.get('h');
      const months = Number(p.get('m') || 3);
      if (!uid || !hash) return new Response('missing params', { status: 400, headers: corsHeaders });
      const now = Date.now() / 1000 | 0;
      const start = now - 60*60*24*7*2;       // 14 Tage zurück
      const end   = now + 60*60*24*30*months; // m Monate voraus
      const api=`https://selfservice.campus-dual.de/room/json?userid=${uid}&hash=${hash}&start=${start}&end=${end}`;
      const r = await fetch(api);
      if (!r.ok) return new Response('upstream error', { status: 502, headers: corsHeaders });
      const rows = await r.json();
      const fmt=d=>d.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
      const ics=[
        'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//campus-dual//worker//EN',
        ...rows.flatMap((row,i)=>[
          'BEGIN:VEVENT',`UID:${uid}-${row.id||i}@campus`,
          `DTSTAMP:${fmt(new Date())}`,
          `DTSTART:${fmt(new Date(row.start*1000))}`,
          `DTEND:${fmt(new Date(row.end*1000))}`,
          `SUMMARY:${(row.text||row.title||'Unterricht').replace(/,/g,'\\,')}`,
          row.room?`LOCATION:${row.room.replace(/,/g,'\\,')}`:'',
          row.course||row.teacher?`DESCRIPTION:${[(row.course||''),(row.teacher||'')].filter(Boolean).join(' – ').replace(/,/g,'\\,')}`:'',
          'END:VEVENT']),'END:VCALENDAR'
      ].join('\r\n');
      return new Response(ics,{
        headers:{
          'Content-Type': 'text/calendar',
          'Cache-Control': 'public, max-age=900',
          ...corsHeaders
        }
      });
    }
  }