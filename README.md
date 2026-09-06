# FitMind

Персональний трекер тренувань українською: Firebase Authentication, Firestore, журнал сесій, відновлення м’язів, улюблені вправи й AI-тренер.

## Дані та авторизація

Акаунти створюються через Firebase Email/Password. Після реєстрації FitMind надсилає лист для підтвердження email; до підтвердження увійти не можна. Кожен користувач зберігається у Firestore як `users/{uid}`, а правила Firestore дозволяють читати й змінювати тільки власний документ.

## Локальний запуск

Потрібен Node.js 20 або новіший.

```powershell
node server.js
```

Відкрий адресу з термінала. Для локального входу Firebase автоматично дозволяє `localhost`.

## Публікація на Netlify

1. Залий репозиторій у GitHub.
2. У Netlify: **Add new project** → імпортуй GitHub-репозиторій.
3. Build command залиш порожнім; Publish directory: `.`. Налаштування вже є у `netlify.toml`.
4. У **Site configuration → Environment variables** додай:
   - `GEMINI_API_KEY` — секретний Gemini-ключ;
   - `FIREBASE_WEB_API_KEY` — значення `apiKey` з Firebase Web config;
   - необов’язково `GEMINI_MODEL`.
5. У Firebase Authentication → Settings → Authorized domains додай домен Netlify, наприклад `твій-сайт.netlify.app`.

Gemini-ключ не потрапляє у браузер: його читає лише Netlify Function `netlify/functions/coach.mjs`. Не додавай `.env` або ключі у GitHub.
