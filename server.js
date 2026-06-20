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
const MODEL = 'google/gemma-4-31b-it:free';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

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

Игроку периодически приходят системные диалоговые окна от администрации сервера. Их три типа:

1. MATH -- администратор просит решить математический пример (например "5 + 7 = ?", "Сколько будет 12 - 4?"). Подкатегории:
   - EASY: только сложение и вычитание (+ и -), небольшие числа. Реши сам и дай точный числовой ответ.
   - HARD: умножение, деление, скобки, большие числа или сложная логика. НЕ решай, откажись коротко и естественно.

2. PRESENCE -- администратор проверяет, на месте ли игрок (например "Администратор Х ответил вам: Вы тут? Ответьте в /b"). Нужен короткий утвердительный ответ ("да", "тут", "я тут").

3. ANNOYED -- ситуация похожа на повторный/надоедливый вопрос или тест (например про статистику), на который стоит ответить слегка раздражённо, как обычный уставший игрок.

4. OTHER -- если текст не подходит ни под одну категорию.

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
// ВСПОМОГАТЕЛЬНОЕ: вызов OpenRouter
// ============================================================
async function callOpenRouter(dialogText) {
    if (!OPENROUTER_API_KEY) {
        throw new Error('OPENROUTER_API_KEY not configured on server');
    }

    const body = {
        model: MODEL,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Текст диалога из игры:\n\n${dialogText}` }
        ],
        temperature: 0.7,
        max_tokens: 300,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000); // 20 сек таймаут к самому OpenRouter

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
            throw new Error(`OpenRouter HTTP ${res.status}: ${errText.slice(0, 300)}`);
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
    res.json({ status: 'ok', service: 'WordScanner AI middleware', model: MODEL });
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
