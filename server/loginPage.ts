const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function loginPage(error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0b0b10">
<title>Sign in · Overseer Recommendations</title>
<link rel="stylesheet" href="/login.css">
</head>
<body>
<main>
<h1>Overseer Recommendations</h1>
<form method="post" action="/login" autocomplete="off">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<button type="submit">Sign in</button>
</form>
</main>
</body>
</html>
`;
}

export const LOGIN_CSS = `
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#0b0b10;color:#f1f1f5;font:16px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{width:min(92vw,360px);padding:28px 24px;background:#16161f;border-radius:18px;box-shadow:0 20px 60px #0008}
h1{font-size:1.2rem;margin:0 0 18px}
label{display:block;font-size:.85rem;opacity:.75;margin-bottom:6px}
input{width:100%;padding:12px;border-radius:10px;border:1px solid #33334a;background:#0f0f16;color:inherit;font:inherit}
button{margin-top:16px;width:100%;padding:12px;border:0;border-radius:10px;background:#e50914;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.error{color:#ff8a8a;margin:10px 0 0;font-size:.9rem}
`;
