# Squeek Wheel 🐹

Telegram mini-app для экосистемы [Squeekchain](https://squeekchain.com): игроки крутят своё колесо вместе с настоящим хомяком Squeektoshi.

- **Хомяк бежит** → его живые обороты бустят каждый спин игроков (×1 … ×7, `1 + rpm/20`).
- **Хомяк спит** → ночная смена: люди крутят колесо сами, но **1000 человеческих спинов = 1 хомячий оборот**.
- Каждый день счёт **«люди vs хомяк»**, лидерборд за день и за всё время.
- Бот шлёт в канал алерты «проснулся / уснул» и утренний итог дня.

Данные о хомяке берутся из публичного фида `https://api.squeekchain.com/v1/status` (статус колеса ACTIVE/IDLE, rpm, счётчик работы). Реальные блоки и SQK этот проект не минтит: это игра поверх их данных, а не часть протокола.

## Как устроено

```
web/index.html      мини-апп (один файл): колесо на canvas, статус хомяка, счёт, лидерборд
worker/             Cloudflare Worker + D1
  src/index.ts      роуты API, бот, cron
  src/game.ts       правила: анти-чит, буст, детектор "проснулся/уснул" (чистые функции)
  src/hamster.ts    чтение и нормализация /v1/status, кэш 5 с, фолбэк
  src/telegram.ts   проверка подписи Telegram initData, отправка сообщений
  schema.sql        таблицы D1
  test/             юнит-тесты (vitest) + интеграционный прогон против локального worker
```

API воркера:

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/api/state` | статус хомяка, текущий буст, счёт «люди vs хомяк» за сегодня |
| POST | `/api/spin` | `{revs, seq}` + заголовок `X-Init-Data` → засчитанные обороты, мои очки |
| GET | `/api/leaderboard?scope=today\|all` | топ-20 |
| POST | `/tg/webhook` | апдейты бота: `/start`, `/top`, `/hamster` |

**Анти-чит.** Каждый батч проверяется подписью Telegram (`initData`, HMAC от токена бота). Сервер засчитывает не больше 6 оборотов в секунду с момента прошлого батча (максимум за 15 с), так что накрутить скриптом быстрее «физического» колеса нельзя. Повтор батча с тем же `seq` отбивается.

## Деплой (бесплатно)

Нужно: Node 20+, отдельный аккаунт Cloudflare, бот.

1. **Бот.** В [@BotFather](https://t.me/BotFather): `/newbot` → получишь токен. Токен никому не кидай.
2. **Установка и логин** (откроется браузер, логинься в *новый* аккаунт Cloudflare):
   ```bash
   cd worker
   npm install
   npx wrangler login
   ```
3. **База:**
   ```bash
   npx wrangler d1 create squeek-wheel
   # вставь выданный database_id в wrangler.toml
   npx wrangler d1 execute squeek-wheel --remote --file=schema.sql
   ```
4. **Секреты** (вводятся в терминал, в файлы не попадают):
   ```bash
   npx wrangler secret put BOT_TOKEN        # токен из BotFather
   npx wrangler secret put WEBHOOK_SECRET   # любая длинная случайная строка
   ```
5. **Воркер:** `npx wrangler deploy` → напечатает адрес вида `https://squeek-wheel.<имя>.workers.dev`.
6. **Мини-апп:** в `web/index.html` впиши этот адрес в `<meta name="api" ...>`, а ссылку на мини-апп (шаг 8) — в `<meta name="app-link" ...>` (её подставляют кнопки «Поделиться»). Потом:
   ```bash
   npx wrangler pages deploy ../web --project-name squeek-wheel-app
   ```
   Получишь `https://squeek-wheel-app.pages.dev`. Впиши его в `wrangler.toml` в `WEBAPP_URL` и `ALLOWED_ORIGIN`, снова `npx wrangler deploy`.
7. **Вебхук бота** (подставь свои значения):
   ```bash
   curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
     -d url=https://squeek-wheel.<имя>.workers.dev/tg/webhook \
     -d secret_token=<WEBHOOK_SECRET>
   ```
8. **Кнопка в боте:** BotFather → `/mybots` → бот → Bot Settings → Menu Button → адрес Pages.
   Чтобы была ссылка вида `t.me/<бот>/<app>` для постов: `/newapp` в BotFather, потом впиши её в `wrangler.toml` как `APP_LINK = "https://t.me/<бот>/<app>"`.
9. **Алерты и итог дня (по желанию):** создай канал, добавь бота админом, узнай id канала (например, `-100...`), впиши в `ALERT_CHAT_ID`, `npx wrangler deploy`.

## Лимиты бесплатного тарифа

- Workers: 100k запросов в сутки. Активный игрок шлёт батч раз в 5 с и опрашивает статус раз в 10 с: около 1k запросов в час.
- D1: 100k записанных строк в сутки — это самый узкий лимит. Батч пишет ~5 строк, то есть примерно **25–30 игроко-часов в сутки** бесплатно.
- Если игра залетит: Workers Paid за $5/мес снимает оба лимита с огромным запасом.

## Локальная проверка

```bash
cd worker
printf 'BOT_TOKEN=123456:TEST_TOKEN_not_real\nWEBHOOK_SECRET=testsecret\n' > .dev.vars
npx wrangler d1 execute squeek-wheel --local --file=schema.sql
npm test                         # юнит-тесты
npx wrangler dev --local --test-scheduled --var DEV_ALLOW_UNSIGNED:1
# мини-апп без Telegram: откройте web/index.html?dev=1&user=5&api=http://127.0.0.1:8787
```

Демо без бэкенда (имитация: хомяк 25 с бежит, 25 с спит, фейковый лидерборд): `web/index.html?demo=1`, или `<meta name="demo" content="1">`.

`DEV_ALLOW_UNSIGNED=1` разрешает запросы без подписи Telegram. **В продакшене он должен быть `"0"`** (так стоит в `wrangler.toml`).

## Что дальше

- Показ счёта «люди vs хомяк» на их стриме / через `!commands` — по ответу команды.
- Карточка итога ночи картинкой для шеров в X.
- Фолбэк на чтение контракта SqueekCore в Sepolia, если фид `/v1/status` недоступен из региона воркера.

Комьюнити-проект, не официальный продукт Squeekchain.
