# Campus Dual → iCal Exporter

Ein elegantes Tool, das den Stundenplan von Campus Dual in ein universelles iCal-Format exportiert. Perfekt für Studenten, die ihren Stundenplan in ihren bevorzugten Kalender integrieren möchten.

> 🎓 Exportiere deinen Campus Dual Stundenplan als iCal-Datei oder abonniere ihn direkt in deinem Kalender. Einfach, schnell und ohne Installation.

[![Live Demo](https://img.shields.io/badge/Live%20Demo-000000?style=flat&logo=github&logoColor=white)](https://xnycrofox.github.io/campus-dual-calendar-tool/)
[![Deploy to Cloudflare Workers](https://img.shields.io/badge/Deploy%20to%20Cloudflare%20Workers-F38020?style=flat&logo=cloudflare&logoColor=white)](https://deploy.workers.cloudflare.com/?url=https://github.com/xNycrofox/campus-dual-calendar-tool)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat)](https://opensource.org/licenses/MIT)

## ✨ Features

- **Einmaliger Export**: Generiere eine `.ics`-Datei für deinen Stundenplan
- **Live-Abonnement**: Abonniere deinen Stundenplan direkt in deinem Kalender
- **Universelle Kompatibilität**: Funktioniert mit allen gängigen Kalender-Apps
  - Google Calendar
  - Apple Calendar
  - Microsoft Outlook
  - Thunderbird
  - und viele mehr...
- **Moderne UI**: Elegantes, responsives Design mit Dark Mode
- **Sicher**: Keine Datenspeicherung, direkte Verbindung zu Campus Dual
- **Performance**: Optimiert für schnelle Ladezeiten und geringen Ressourcenverbrauch

## 🚀 Technologie-Stack

- **Frontend**:
  - Vanilla JavaScript
  - TailwindCSS für das UI
  - Inter Font für optimale Lesbarkeit
- **Backend**:
  - Cloudflare Workers für serverless API
  - iCal-Format für universelle Kalenderkompatibilität
- **Deployment**:
  - GitHub Pages für das Frontend
  - Cloudflare Workers für die API

## Nutzung

**Parameter:**
- `u`: Matrikelnummer (userid)
- `h`: Hash
- `m`: Anzahl der Monate (optional, Standard: 3)

**Beispiel:**
```
https://cdual-ics.xnycrofox.workers.dev/ical?u=3005182&h=12fca58f9d8f9f649269060c9aa51412&m=6
```

**Response:**
- Content-Type: `text/calendar`
- Cache-Control: `public, max-age=900`

## 🤝 Contributing

Beiträge sind willkommen! Bitte folge diesen Schritten:

1. Fork das Repository
2. Erstelle einen Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Committe deine Änderungen (`git commit -m 'Add some AmazingFeature'`)
4. Pushe zum Branch (`git push origin feature/AmazingFeature`)
5. Öffne einen Pull Request

## 📄 Lizenz

Dieses Projekt ist unter der MIT-Lizenz lizenziert - siehe die [LICENSE](LICENSE) Datei für Details.

## 🙏 Danksagung

- [Campus Dual](https://www.campus-dual.de) für die Bereitstellung der API
- [Cloudflare](https://www.cloudflare.com) für die Workers-Plattform
- [TailwindCSS](https://tailwindcss.com) für das wundervolle CSS-Framework
