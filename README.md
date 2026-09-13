# Invite Bay (web)

Чисто фронтовое приложение: **GramJS (`telegram`)** в браузере, без бэкенда.

Те же параметры, что в Windows-приложении:

- API_ID / API_HASH
- канал / супергруппа
- список username / id
- паузы, лимит, dry-run
- живой лог + стоп

## Запуск

```powershell
cd C:\Users\Slava\telegram-auto-invite\web
npm install
npm run dev
```

Откройте URL из терминала (обычно http://localhost:5173). Удобно с телефона в той же Wi‑Fi-сети — Vite слушает `host: true`.

## Сборка статики

```powershell
npm run build
npm run preview
```

Артефакты: `web/dist/` — можно выложить на любой static hosting (GitHub Pages, Netlify, Cloudflare Pages).  
**Важно:** это user-client с вашими ключами и сессией в `localStorage`. Не публикуйте как общий сервис для чужих аккаунтов без понимания рисков.

## Отличия от desktop

| | Desktop (Telethon) | Web (GramJS) |
| --- | --- | --- |
| Где крутится | `.exe` / Python | браузер |
| Сервер | не нужен | не нужен |
| Сессия | `.session` файл | `localStorage` |
| Сеть | MTProto напрямую | WebSocket MTProto |

## Лимиты Telegram

Те же: `FloodWait`, `PEER_FLOOD`, privacy. Не крутите массовый spam-add.
