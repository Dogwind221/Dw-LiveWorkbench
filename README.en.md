# Dw LiveWorkbench — a zero-dependency AI workbench for livestream content

**English summary.** The full documentation is in Chinese; this page is enough to evaluate the project.

> A local-first, **zero-dependency** Node.js workbench that takes a live-selling session from topic selection to script, compliance check and post-show review.
> Built by one person for a real Pu'er-tea business, then generalized just enough to be portable.

---

## What it does

| # | Module | What it does | LLM cost |
| --- | --- | --- | --- |
| 1 | Deck + script generator | topic → outline → slides → verbatim script → PPTX | **0 tokens** (deterministic templates) |
| 2 | Domain knowledge base | 44 mountains + 38 teas, editable | **0** |
| 3 | **RAG Q&A** | retrieves from the KB, answers **with citations** | ~1,400 tokens / call |
| 4 | **AI agent** | natural language → tool calls (7 tools), write actions need human confirmation | ~30k tokens / run |
| 5 | Teleprompter + comment Q&A | full-screen prompter; rule-based answers for live comments | **0** |
| 6 | Review + compliance | post-show metrics; 244 banned terms + 17 regex + 10 context rules | **0** |
| 7 | Topic/intel collection | RSS or manual entry → auto-tagging → show topics | **0** |
| 8 | Batch + A/B | generate many decks at once; compare variants side by side | **0** |

> **Only 2 of the 10 modules ever call a model.** The rest is deterministic and reproducible.

---

## Tech highlights (all measurable)

| Area | Detail |
| --- | --- |
| **Zero dependencies** | `dependencies: {}` — only `node:` built-ins (http / crypto / fs / url) |
| **Retrieval** | self-built BM25 + character n-gram hashed vectors, weighted RRF (rrfK=5, 0.9 / 0.1); 552 chunks |
| **Retrieval quality** | **recall@5 = 0.974**, MRR = 0.762 on a 56-question labelled set |
| **Agent** | hand-written ReAct loop, 432 lines; 8 steps / 12 tool calls hard cap; 7 tools (5 read, 2 write) |
| **Write safety** | two-phase commit — the model can only *propose*; a human confirms before execution |
| **Multi-tenant** | `AsyncLocalStorage` context, token-only identity, 3-role RBAC, audit trail, quota & cost metering |
| **HTTP** | `node:http` with 67 hand-written routes (no express) |
| **Frontend** | vanilla JS, 22 design tokens, responsive down to 390 px |
| **Tests** | **372 automated assertions** across 8 smoke suites |

Numbers from the RAG and agent benchmarks are reproducible offline:

```bash
node scripts/rag-eval.mjs --offline      # recall@5 / MRR, deterministic
node scripts/rag-probe.mjs               # zero-overlap probe — exposes retrieval weakness
node scripts/rag-smoke.mjs               # 28 assertions
node scripts/agent-smoke.mjs             # 147 assertions
node scripts/smoke.mjs                   # core modules
```

---

## Quick start

```bash
# Node >= 20. No npm install required.
node server/index.mjs
# open http://127.0.0.1:8788
```

On Windows you can also double-click `启动.bat` (`启动-局域网.bat` to expose it on the LAN).

Requires a chat-model API key only for module 3 and 4 (OpenAI-compatible endpoint, defaults to DeepSeek).
Everything else works fully offline.

---

## Known limitations (honest)

| Limitation | Reality |
| --- | --- |
| **Not validated at scale** | The only real user is the author. Multi-tenant is a skeleton, no second company uses it. |
| **Vectors are not neural embeddings** | Character n-gram hashing — weak semantic generalization. On the zero-overlap probe, 2 of 8 queries fail badly. |
| **Single-machine JSON storage** | Small data is a feature (readable, hand-editable); concurrent writes are a risk. |
| **No load testing** | No QPS numbers. Single process. |
| **No CI / container / HA** | No GitHub Actions, no Dockerfile, no replication. Engineering discipline yes; production operations no. |

---

## Docs

| Topic | File |
| --- | --- |
| Full product documentation (Chinese) | [README.md](README.md) |
| RAG design and trade-offs | [README-rag.md](README-rag.md) |
| Agent, tools, write safety | [README-agent.md](README-agent.md) |
| Multi-tenant / auth / RBAC / quota | [README-multitenant.md](README-multitenant.md) |
| Batch generation and A/B | [README-efficiency.md](README-efficiency.md) |
| Engineering post-mortems (21 entries) | [研发日志.md](研发日志.md) |
| **Porting to another industry** | [docs/PORTING.md](docs/PORTING.md) |
| Admin runbook (fix wrong answers) | [管理员手册.md](管理员手册.md) |

---

## License

MIT — see [LICENSE](LICENSE).

You may use, modify and distribute it freely, **including commercially**.
Attribution is the only requirement.

If you build something on top of it, an issue or a note is welcome (not required).

---

## Contact

GitHub: [@Dogwind221](https://github.com/Dogwind221)
