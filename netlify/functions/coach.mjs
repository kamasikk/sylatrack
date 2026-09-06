const complete = text => String(text || '').trim().length >= 45 && /[.!?…][”"')\]]*$/.test(String(text || '').trim());

export default async request => {
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405 });
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return Response.json({ error: 'Потрібна авторизація.' }, { status: 401 });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return Response.json({ available: false, state: 'key' });
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Некоректний запит.' }, { status: 400 }); }
  const question = String(body?.question || '').trim().slice(0, 500);
  if (!question) return Response.json({ error: 'Напиши питання для тренера.' }, { status: 400 });
  const history = Array.isArray(body?.history) ? body.history.slice(-8).map(item => ({ role: item?.role === 'model' ? 'model' : 'user', text: String(item?.text || '').slice(0, 900) })).filter(item => item.text) : [];
  const context = JSON.stringify(body?.context || {}).slice(0, 18000);
  const identityKey = process.env.FIREBASE_WEB_API_KEY;
  if (!identityKey) return Response.json({ available: false, state: 'config' });
  const check = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(identityKey)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }) });
  const identity = await check.json().catch(() => ({}));
  if (!check.ok || !identity?.users?.[0]?.emailVerified) return Response.json({ error: 'Потрібна підтверджена авторизація.' }, { status: 401 });
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const contents = [
    { role: 'user', parts: [{ text: `Ось актуальний контекст користувача FitMind. Спирайся на нього, але не переказуй JSON: ${context}` }] },
    { role: 'model', parts: [{ text: 'Контекст FitMind отримано.' }] },
    ...history.map(item => ({ role: item.role, parts: [{ text: item.text }] })),
    { role: 'user', parts: [{ text: question }] }
  ];
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ systemInstruction: { parts: [{ text: 'Ти FitMind — уважний персональний фітнес-помічник українською. Відповідай природно на «ти», максимум 120 словами і завжди закінчуй останнє речення крапкою. Використовуй короткі абзаци або простий список. Враховуй recovery: не радь важко навантажувати м’яз нижче 70%, а нижче 50% порадь відпочинок або іншу групу. Не вигадуй показники, не показуй JSON, не став діагнозів.' }] }, contents, generationConfig: { maxOutputTokens: 2000, thinkingConfig: { thinkingLevel: 'LOW' } } }) });
    const result = await response.json().catch(() => ({}));
    const candidate = result?.candidates?.[0];
    const answer = candidate?.content?.parts?.filter(part => !part.thought).map(part => part.text || '').join('').trim();
    if (!response.ok || candidate?.finishReason && candidate.finishReason !== 'STOP' || !complete(answer)) return Response.json({ available: false, state: response.status === 429 || response.status === 503 ? 'limit' : 'incomplete' });
    return Response.json({ available: true, answer });
  } catch { return Response.json({ available: false, state: 'network' }); }
};
