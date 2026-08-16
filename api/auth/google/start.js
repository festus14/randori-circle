export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: 'Missing GOOGLE_CLIENT_ID env', hint: 'Set GOOGLE_CLIENT_ID in Vercel Env Vars' });
  }
  const appUrl = (process.env.APP_URL || 'https://randori-circle-self.vercel.app').replace(/\/$/, '');
  const redirectUri = `${appUrl}/api/auth/google/callback`;

  const state = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'consent',
    state
  });

  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  res.writeHead(302, { Location: url });
  res.end();
}
