# WordScanner AI Middleware

Прокси-сервер между игровым ботом (Lua/Monetloader) и OpenRouter (модель `google/gemma-4-31b-it:free`).
Деплоится на Render.com, бот делает к нему обычные HTTP-запросы, не дожидаясь напрямую OpenRouter из игры.

## Зачем нужен этот сервер

Игра (Monetloader/SAMP) — слабое окружение для прямых HTTPS-запросов к внешним AI-API:
долгое TLS-рукопожатие может подвешивать игровой поток. Этот сервер берёт всю
работу с OpenRouter на себя, бот общается с ним коротким и быстрым запросом.

## Деплой на Render.com

1. Залей эту папку в GitHub-репозиторий (публичный или приватный — не важно).
2. На Render.com: **New** → **Web Service** → подключи репозиторий.
3. Render автоматически подхватит `render.yaml` (Blueprint), либо настрой вручную:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
4. В разделе **Environment** добавь переменную:
   - `OPENROUTER_API_KEY` = твой ключ с https://openrouter.ai/keys (бесплатная регистрация)
5. Deploy. После сборки получишь URL вида `https://wordscanner-ai-middleware.onrender.com`

## Важно: "холодный старт"

Бесплатный план Render усыпляет сервис после 15 минут бездействия.
Следующий запрос после паузы займёт 30-60 секунд (сервер просыпается).
Бот должен:
- иметь увеличенный таймаут на первый запрос после долгой паузы
- по желанию — пинговать `/ping` каждые 10-14 минут, чтобы сервис не засыпал
  (см. `keepalive.lua` рядом со скриптом бота, либо настроить внешний крон-пингер
  типа UptimeRobot/cron-job.org, который раз в 10 минут дёргает `/ping`)

## Эндпоинты

### `GET /` и `GET /ping`
Health-check, возвращает `{status: "ok"}` / `{pong: true}`. Используется для прогрева.

### `POST /analyze`
Основной эндпоинт.

**Запрос:**
```json
{ "text": "Администратор Ivan_Ylanovski ответил вам: Сколько будет 5 + 7?" }
```

**Ответ:**
```json
{
  "ok": true,
  "category": "math",
  "math_difficulty": "easy",
  "math_answer": 12,
  "response_text": "12"
}
```

Возможные значения `category`: `math`, `presence`, `annoyed`, `other`.

## Локальный запуск (для теста перед деплоем)

```bash
npm install
OPENROUTER_API_KEY=sk-or-v1-xxxx npm start
```

Затем:
```bash
curl -X POST http://localhost:3000/analyze \
  -H "Content-Type: application/json" \
  -d '{"text":"Администратор X ответил вам: Сколько будет 5 + 7?"}'
```
