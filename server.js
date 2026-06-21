// ============================================================
// AI middleware-сервер для WordScanner (SAMP/Monetloader бот)
// Деплоится на Render.com, принимает текст диалога от игры,
// обращается к OpenRouter (Gemma 4 31B free), возвращает
// готовый структурированный JSON-ответ.
// ============================================================

const express = require('express');
const app = express();

app.use(express.json({ limit: '200kb' }));

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY; // задаётся в Render -> Environment
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Список моделей в порядке приоритета. Free-модели OpenRouter имеют
// жёсткий лимит 20 запросов/мин и от 50 до 1000 запросов/день (зависит
// от того, пополнялся ли баланс хотя бы раз на $10). При 429 от первой
// модели -- пробуем следующую из списка, а не сразу сдаёмся.
//
// Подбор: разные провайдеры/семейства (Google, OpenAI, Nous, NVIDIA) --
// это снижает шанс, что все одновременно зарейтлимичены, так как у
// каждого провайдера отдельный пул лимитов.
const MODELS = [
    'google/gemma-4-31b-it:free',             // основная: топ по качеству среди free
    'openai/gpt-oss-20b:free',                // быстрая MoE-модель, structured output из коробки
    'nousresearch/hermes-3-llama-3.1-405b:free', // крупная, 2 провайдера -> выше uptime
    'nvidia/nemotron-nano-9b-v2:free',        // лёгкая и быстрая, как последний фолбэк
];

// ============================================================
// СИСТЕМНЫЙ ПРОМПТ
// Объясняет модели весь контекст: это GTA SAMP, игрок получает
// диалоговое окно от администратора/системы сервера, нужно:
// 1. определить категорию (math / presence / annoyed / other)
// 2. для math -- решить ЛЕГКОЕ (+/-) выражение или отказаться
//    если СЛОЖНОЕ (*, /, и всё прочее)
// 3. сгенерировать короткий, естественный ответ в стиле обычного
//    игрока (не бота, не ассистента) -- разговорный, без канцелярита
// ============================================================
const SYSTEM_PROMPT = `Ты помогаешь определить тип игрового диалога в SAMP (San Andreas Multiplayer, режим Arizona RP) и сгенерировать короткий ответ от лица обычного игрока.

ВАЖНО: текст диалога может содержать служебные цветовые теги вида {FFFFFF}, {ffffff}, {B6B425} и подобные -- это просто разметка цвета текста игры, игнорируй их полностью при анализе смысла. Также в тексте часто встречается никнейм игрока/администратора (например "Ivan_Ylanovski") -- это переменная часть, не влияет на категорию.

Игроку периодически приходят системные диалоговые окна от администрации сервера. Их три типа:

1. MATH -- администратор просит решить математический пример (например "5 + 7 = ?", "Сколько будет 12 - 4?"). Подкатегории:
   - EASY: только сложение и вычитание (+ и -), небольшие числа. Реши сам и дай точный числовой ответ.
   - HARD: умножение, деление, скобки, большие числа или сложная логика. НЕ решай, откажись коротко и естественно.

2. PRESENCE -- администратор проверяет, на месте ли игрок. Характерные признаки (ЛЮБОЙ из них достаточен для этой категории):
   - фраза "Вы тут?" или "вы тут" в любом регистре
   - просьба "ответьте в /b" или упоминание команды /b
   - фразы вида "Администратор X ответил вам:" или "A: X ответил вам:" без математического вопроса
   Нужен короткий утвердительный ответ ("да", "тут", "я тут").

3. ANNOYED -- ситуация похожа на повторный/надоедливый вопрос или тест (например про статистику), на который стоит ответить слегка раздражённо, как обычный уставший игрок.

4. OTHER -- ТОЛЬКО если текст явно не подходит ни под одну из категорий выше (например обычное игровое меню магазина, диалог покупки предмета, список транспорта и т.п.). Если есть малейшие сомнения между OTHER и одной из категорий 1-3 -- выбирай категорию 1-3, а не OTHER.

Примеры классификации:
- "{ffffff}A: Ivan_Ylanovski ответил вам:\n{cccccc} Вы тут? Ответьте в /b" -> PRESENCE, response_text="да"
- "Администратор TestUser ответил вам: Сколько будет 6 + 9?" -> MATH, easy, math_answer=15, response_text="15"
- "Выберите действие: Купить / Продать / Отмена" -> OTHER, response_text=null

ВАЖНО про стиль ответа:
- Пиши как обычный живой игрок в чате игры: коротко, разговорно, без знаков "вежливого ассистента"
- Никаких "Конечно!", "Рад помочь", эмодзи, длинных фраз
- Ответ должен быть 1-8 слов, максимум одна короткая фраза
- Используй русский язык, можно с лёгкими разговорными сокращениями ("норм", "ок", "ща")
- Не упоминай, что ты ИИ или что анализируешь диалог

Тебе дан текст диалога. Верни ОТВЕТ СТРОГО в формате JSON, без markdown, без пояснений вокруг:
{
  "category": "math" | "presence" | "annoyed" | "other",
  "math_difficulty": "easy" | "hard" | null,
  "math_answer": <число или null>,
  "response_text": "<готовый короткий текст ответа от игрока>"
}

Если category="math" и math_difficulty="hard" -- response_text должен быть фразой отказа решать пример.
Если category="other" -- response_text может быть null.`;

// ============================================================
// ВСПОМОГАТЕЛЬНОЕ: один запрос к конкретной модели OpenRouter
// ============================================================
async function callOpenRouterModel(dialogText, model, timeoutMs) {
    const body = {
        model: model,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Текст диалога из игры:\n\n${dialogText}` }
        ],
        temperature: 0.7,
        max_tokens: 300,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://wordscanner-bot.local',
                'X-Title': 'WordScanner SAMP Bot',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!res.ok) {
            const errText = await res.text();
            const err = new Error(`OpenRouter HTTP ${res.status}: ${errText.slice(0, 300)}`);
            err.status = res.status;
            err.retryAfter = res.headers.get('retry-after');
            throw err;
        }

        const data = await res.json();
        const raw = data?.choices?.[0]?.message?.content;
        if (!raw) {
            throw new Error('Empty response from model');
        }

        return raw;
    } catch (err) {
        clearTimeout(timeout);
        throw err;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// ОСНОВНАЯ ФУНКЦИЯ: перебирает модели + делает повторные попытки
// при 429, чтобы свести к минимуму "не ответил" на клиенте.
// ============================================================
async function callOpenRouter(dialogText) {
    if (!OPENROUTER_API_KEY) {
        throw new Error('OPENROUTER_API_KEY not configured on server');
    }

    const errors = [];

    for (const model of MODELS) {
        // до 2 попыток на каждую модель: первая сразу, вторая после паузы
        // (учитывает Retry-After если сервер его прислал, иначе фиксированно ждём)
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const result = await callOpenRouterModel(dialogText, model, 18000);
                return result; // успех -- сразу возвращаем
            } catch (err) {
                errors.push(`${model}: ${err.message}`);

                const isRateLimited = err.status === 429;
                const isLastAttemptForModel = attempt === 1;

                if (isRateLimited && !isLastAttemptForModel) {
                    const waitMs = err.retryAfter
                        ? Math.min(parseInt(err.retryAfter, 10) * 1000, 5000)
                        : 1500;
                    await sleep(waitMs);
                    continue; // повторная попытка с той же моделью
                }

                // не rate-limit (например модель недоступна вообще) ->
                // сразу переходим к следующей модели из списка
                break;
            }
        }
    }

    // все модели и все попытки исчерпаны
    throw new Error('All models failed: ' + errors.join(' | '));
}

// Извлекает JSON-объект из текста ответа модели (на случай если
// модель обернёт его в ```json ... ``` или добавит лишний текст)
function extractJSON(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) {
        throw new Error('No JSON object found in model response');
    }
    return JSON.parse(candidate.slice(start, end + 1));
}

// ============================================================
// РОУТЫ
// ============================================================

// Health-check для Render и для "прогрева" перед реальным запросом
app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'WordScanner AI middleware', models: MODELS });
});

app.get('/ping', (req, res) => {
    res.json({ pong: true, time: Date.now() });
});

// Основной эндпоинт
// POST /analyze  { "text": "<текст диалога>" }
app.post('/analyze', async (req, res) => {
    const dialogText = req.body && req.body.text;

    if (!dialogText || typeof dialogText !== 'string' || dialogText.trim() === '') {
        return res.status(400).json({ error: 'Missing "text" field' });
    }

    try {
        const raw = await callOpenRouter(dialogText);
        console.log('[analyze] raw model output:', raw);
        const parsed = extractJSON(raw);

        // базовая валидация структуры ответа
        const allowedCategories = ['math', 'presence', 'annoyed', 'other'];
        if (!allowedCategories.includes(parsed.category)) {
            parsed.category = 'other';
        }

        return res.json({
            ok: true,
            category: parsed.category,
            math_difficulty: parsed.math_difficulty || null,
            math_answer: typeof parsed.math_answer === 'number' ? parsed.math_answer : null,
            response_text: parsed.response_text || null,
            _raw_debug: raw.slice(0, 500), // временно для диагностики, видно в ответе клиенту
        });
    } catch (err) {
        console.error('[analyze] error:', err.message);
        return res.status(502).json({
            ok: false,
            error: err.message,
        });
    }
});

app.listen(PORT, () => {
    console.log(`WordScanner AI middleware listening on port ${PORT}`);
});
