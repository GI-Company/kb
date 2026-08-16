# Kernos + BNLM: Positioning & Commercialization Notes

**Document Status:** Personal project notes
**Date:** March 2026 (original); last revised August 2026
**Subject:** What this project demonstrates, and where real value could come from

## 1. What This Actually Is

This is a personal technical exploration, not a funded startup or a product with users. It's worth being direct about that, since the original version of this document made claims (a 19MB single-binary local-AI product with zero inference cost and a P2P data moat) that described a different, earlier iteration of the project. The current version is a Vercel-deployed web app: a polished agent-chat shell backed by Groq, with a genuinely client-side trainable language model as its distinguishing feature.

**Project Type:** Technical portfolio piece / architecture demonstration
**Primary Value:** Demonstrates full-stack systems work across a real serverless migration (stateless functions replacing a persistent backend), a working from-scratch ML training loop shipped in a browser, and a coherent agentic tool-call design connecting the two.
**Audience:** Anyone evaluating engineering judgment on a nontrivial full-stack + ML systems project — this isn't pitched as an investable company.

## 2. What's Genuinely Novel Here

Most "local AI" marketing describes a cloud API call with a local UI wrapped around it. This project's actual differentiator is narrower and more honest: **a real training loop (autograd, three attention variants, Adam, gradient checking) runs in the browser tab**, and a cloud model (Groq) can direct it via tool calls. That combination — fast cloud reasoning deciding when to invoke a private, zero-marginal-cost, offline-capable local model — is a genuinely underexplored pattern, independent of whether this specific implementation ever becomes a product.

## 3. Where Real Costs and Constraints Are

- **Groq inference isn't free.** Every agent chat call costs whatever Groq charges per token for the configured model. This is a real, ongoing operating cost proportional to usage — not eliminated the way the original "zero cloud inference cost via LM Studio" claim suggested, because LM Studio required the user's own local GPU, which most web app users don't have available to a browser tab. Three mechanisms currently bound that exposure: per-IP rate limiting, a 15-minute daily cap on guest sessions, and per-execution call budgets inside the agent code sandbox. The rate limiter is in-memory and therefore per-instance, not distributed — a real gap under concurrent load, and the one place this would need to change first if usage grew.
- **Some capabilities are gated by hosting tier, not by code.** The headless-browser `render` command needs a paid plan: a Chromium cold start plus a page load does not fit inside a 10-second function limit on any configuration. This is worth naming because it is the clearest case where the product ceiling is a billing decision rather than an engineering one.
- **BNLM's local training is genuinely free at inference/training time** (just the user's own CPU/GPU cycles via WebGPU), but it's also genuinely small-scale — this is not a replacement for the cloud model's reasoning capability, it's a complementary, private, specialist component.
- **No persistent backend means no real moat from data.** The original document's "P2P data defensibility" argument doesn't apply to a stateless serverless deployment with no P2P layer built. If a real product were built on this pattern, the moat would have to come from the tool-call UX and the specific fine-tuning/specialization workflow, not from data non-exfiltration.

## 4. Plausible Directions, If This Became a Product

1. **Specialist model marketplace.** If users can train and name small local models on their own data, a natural extension is sharing/selling trained `.qlm1` exports for narrow tasks (a support-ticket classifier, a house-style text generator) — genuinely private since the base model never had the data centrally, only the user's tab did.
2. **Agent-directed fine-tuning as a product surface.** The tool-call pattern (cloud model decides when to train/query a local model) generalizes beyond BNLM's toy Transformer to larger WebGPU-capable local models as browser compute budgets grow.
3. **Bring-your-own-backend for the remaining cut features.** Accounts have since been built on Supabase, which also covers the vector-memory path (pgvector in the same project) if there's ever demand for the fuller original vision. Multi-user collaboration remains unbuilt.

## 5. Risk Factors, Honestly

- **Groq API dependency.** The entire cloud-reasoning half of the app depends on Groq's API being available and priced sensibly; there's no fallback local model of comparable capability.
- **Serverless constraints are real, not cosmetic.** `api/exec.ts`'s allowlist is smaller than a real host's toolset, function execution has a hard time limit, and there's no persistent workspace between commands — these are permanent properties of the deployment target, not gaps to be closed later.
- **BNLM's scale ceiling.** Training a meaningfully larger model in a browser tab is bounded by WebGPU support and available device memory; this isn't a path to a large general-purpose local model.

## 6. Conclusion

This project is positioned as a demonstration of judgment under real constraints — building the compelling parts of an ambitious original vision (a cognitive OS) into what a stateless, zero-infrastructure deployment can actually support, rather than either abandoning the idea or shipping something that silently doesn't work. The honest scope-down (six cuts documented in [ARCHITECTURE.md](./ARCHITECTURE.md), each with a stated reason) is itself the artifact worth evaluating alongside the working code.
