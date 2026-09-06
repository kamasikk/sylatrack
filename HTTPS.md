# HTTPS для FitMind

Для локального запуску використовуй `http://localhost` — це нормально.

Для публічного сайту з доменом найпростіше поставити Caddy на сервері, замінити домен у `Caddyfile` та запустити:

```powershell
caddy run
```

Caddy автоматично отримає справжній HTTPS-сертифікат і оновлюватиме його. Домен має бути прив’язаний до IP сервера.

Альтернатива: задай шляхи до готових PEM-сертифікатів:

```powershell
$env:SSL_KEY_PATH='C:\certs\privkey.pem'
$env:SSL_CERT_PATH='C:\certs\fullchain.pem'
node server.js
```

Тоді FitMind запуститься напряму через HTTPS, а cookie сесії автоматично отримає прапорець `Secure`.
