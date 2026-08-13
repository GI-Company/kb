// Dev-only Vite plugin that runs api/*.ts handlers in-process during
// `npm run dev`, so the app is fully testable locally without the Vercel
// CLI/account. Production deploys ignore this entirely — Vercel's own build
// picks up api/*.ts independently. Two calling conventions are bridged here
// because the real handlers use two different Vercel runtimes:
//   - api/chat.ts is an Edge function: (Request) => Response
//   - api/exec.ts is a Node function: (req, res) classic signature
import type { Plugin, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function asVercelRes(res: ServerResponse) {
  const r = res as ServerResponse & { status: (code: number) => typeof r; json: (data: unknown) => void };
  r.status = (code: number) => {
    r.statusCode = code;
    return r;
  };
  r.json = (data: unknown) => {
    r.setHeader('content-type', 'application/json');
    r.end(JSON.stringify(data));
  };
  return r;
}

export function apiDevPlugin(): Plugin {
  return {
    name: 'kernos-api-dev',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next();

        if (req.url.startsWith('/api/chat')) {
          try {
            const bodyBuf = await readBody(req);
            const mod = await server.ssrLoadModule('/api/chat.ts');
            const request = new Request(new URL(req.url, 'http://localhost'), {
              method: req.method,
              headers: req.headers as Record<string, string>,
              body: bodyBuf.length ? bodyBuf : undefined,
            });
            const response: Response = await mod.default(request);
            res.statusCode = response.status;
            response.headers.forEach((v, k) => res.setHeader(k, v));
            if (response.body) {
              const reader = response.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
              }
            }
            res.end();
          } catch (err: any) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: err?.message || String(err) }));
          }
          return;
        }

        if (req.url.startsWith('/api/exec')) {
          try {
            const bodyBuf = await readBody(req);
            let parsedBody: unknown = {};
            try { parsedBody = bodyBuf.length ? JSON.parse(bodyBuf.toString('utf8')) : {}; } catch { /* leave {} */ }
            (req as any).body = parsedBody;
            const mod = await server.ssrLoadModule('/api/exec.ts');
            await mod.default(req, asVercelRes(res));
          } catch (err: any) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: err?.message || String(err) }));
          }
          return;
        }

        next();
      });
    },
  };
}
