// Headless-Chromium page rendering — backs the terminal's `render` command
// (see apps/Terminal.tsx / lib/networkCommands.ts's sibling network
// commands). A real browser, not a fetch: this is for pages that need JS
// to render anything meaningful, which curl can't do.
//
// Separate function from api/exec.ts on purpose — a Chromium cold start
// alone commonly takes several seconds, well past what exec.ts's other
// commands need, so this gets its own much longer duration/memory budget
// in vercel.json rather than sharing exec.ts's tight 10s/default memory.
//
// Requires Vercel Pro (or higher). Hobby's hard 10s function-duration cap
// isn't enough headroom for a Chromium cold start plus page load — this
// will time out on Hobby regardless of what's configured here, and the
// bundled chromium binary is large enough that Hobby's deployment size
// limits can also be a problem. Gated to signed-in accounts only, same
// reasoning as api/exec.ts's network commands: an anonymous, IP-quota-only
// terminal that can launch a real browser against arbitrary URLs is a
// meaningfully worse abuse vector than curl alone, and browser compute is
// the most expensive thing this project runs per-request.
//
// Request:  POST { url: string, mode?: 'text' | 'screenshot' }
// Response: { code: number, title?: string, text?: string, screenshot?: string (base64 PNG), stderr?: string }

import { checkRateLimit, rateLimitResponseHeaders } from '../lib/rateLimit.js';
import { verifyAccessToken, extractBearerToken } from '../lib/verifyAuth.js';
import { assertPublicHost } from '../lib/networkGuard.js';

const RATE_LIMIT_PER_MIN = 5; // heavier resource cost per call than exec.ts's commands
const NAV_TIMEOUT_MS = 25000;
const MAX_TEXT_CHARS = 20_000;

interface RenderBody {
  url?: string;
  mode?: 'text' | 'screenshot';
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const user = await verifyAccessToken(extractBearerToken(req));
  if (!user) {
    res.status(200).json({ code: 1, stderr: 'render: requires a signed-in account — guests get the sandboxed coreutils/network-free terminal only.\n' });
    return;
  }

  const rl = checkRateLimit(`render:${user.id}`, RATE_LIMIT_PER_MIN);
  for (const [k, v] of Object.entries(rateLimitResponseHeaders(rl))) res.setHeader?.(k, v);
  if (!rl.allowed) {
    res.status(429).json({ code: 1, stderr: `Rate limit exceeded (${RATE_LIMIT_PER_MIN}/min for page rendering — this is expensive to run). Try again shortly.\n` });
    return;
  }

  const body: RenderBody = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const urlStr = body.url;
  const mode: 'text' | 'screenshot' = body.mode === 'screenshot' ? 'screenshot' : 'text';

  if (!urlStr) {
    res.status(400).json({ code: 1, stderr: 'render: missing "url"\n' });
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    res.status(200).json({ code: 1, stderr: `render: invalid URL "${urlStr}"\n` });
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    res.status(200).json({ code: 1, stderr: `render: protocol "${parsed.protocol}" is not allowed — only http/https\n` });
    return;
  }
  try {
    await assertPublicHost(parsed.hostname);
  } catch (err: any) {
    res.status(200).json({ code: 1, stderr: `render: ${err.message}\n` });
    return;
  }

  let browser: any;
  try {
    const [{ default: chromium }, puppeteer] = await Promise.all([
      import('@sparticuz/chromium'),
      import('puppeteer-core'),
    ]);

    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    // Re-validates every navigation/document request (including redirect
    // hops) against the SSRF guard before letting it proceed — page.goto()
    // alone would follow a redirect into a private IP before we ever got a
    // chance to inspect it. Sub-resource requests (images, scripts, XHR)
    // are let through unchecked for simplicity/latency — a narrower,
    // documented gap rather than an unexamined one.
    await page.setRequestInterception(true);
    page.on('request', async (request: any) => {
      if (request.isNavigationRequest() || request.resourceType() === 'document') {
        try {
          await assertPublicHost(new URL(request.url()).hostname);
          request.continue();
        } catch {
          request.abort();
        }
      } else {
        request.continue();
      }
    });

    await page.goto(parsed.toString(), { waitUntil: 'domcontentloaded' });
    const title = await page.title();

    if (mode === 'screenshot') {
      const buf = await page.screenshot({ type: 'png' });
      res.status(200).json({ code: 0, title, screenshot: Buffer.from(buf).toString('base64') });
    } else {
      const text: string = await page.evaluate(() => document.body?.innerText || '');
      const truncated = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) + '\n...[truncated]' : text;
      res.status(200).json({ code: 0, title, text: truncated });
    }
  } catch (err: any) {
    res.status(200).json({ code: 1, stderr: `render: ${err?.message || err}\n` });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
