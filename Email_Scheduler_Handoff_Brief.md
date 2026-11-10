# Email Scheduler: Handoff Brief for the Next Agent

> **How to use this file:** paste it (or attach it) at the start of a new conversation with another AI agent, then say: *"Read this brief, then continue with the next phase."* If possible, also attach `Email_Scheduler_Project_Documentation.md`, which holds the complete tested reference code for every phase.

---

## 0. Instructions for the agent (read first)

You are helping a student build a backend portfolio project **step by step**. Follow these rules:

1. **One phase at a time.** Give the code for the current phase only, tell the user exactly how to run and test it, then wait for their result before starting the next phase.
2. **Explain in simple, easy language, in detail.** The user has asked for explanations of **every line of code** (what each import, line, and command does and why). After giving code, explain it chunk by chunk.
3. **Give complete, copy-paste-ready code** with the exact file path for each file. Never give partial snippets that need guessing.
4. **The user is on Windows using PowerShell** and VS Code. Use PowerShell syntax (see section 7 for pitfalls). Always say which folder to run commands from.
5. **Do not claim anything works unless you have verified it.** Prefer code you have typechecked and run. If you cannot test something, say so plainly.
6. **Be honest and accurate.** Do not invent features. If the user is unsure about a limitation, explain it truthfully. This matters because the project will be used in interviews and on a resume.
7. **When an error is pasted**, find the root cause, explain it simply, and give the exact fix. Ask for the full error output if needed.
8. The user prefers short confirmations like "fast" when they want the quick path: then give only the minimum commands.

---

## 1. The user and their preferences

- Student building a portfolio project and preparing for interviews.
- Knows **MongoDB** well, but is **new to PostgreSQL/SQL**.
- Has **not covered Docker deeply**: uses Docker Compose only to run Postgres and Redis locally. Do **not** let resume text claim Docker deployment experience.
- Wants resume bullets that name the tech stack in the first bullet, and (for now) **no Docker mention**.
- Wants interview-style understanding: why each choice was made, trade-offs, limitations.
- Machine: Windows (Docker Desktop with WSL 2). Project path: `D:\Code\Personal_project\Email_Scheduler`.

---

## 2. What the project is

A TypeScript backend that **schedules emails to be sent at a future time**.

- An **Express API** validates requests, saves each email as a row in **PostgreSQL** (via **Prisma**), and adds a **delayed job** to a **Redis-backed BullMQ queue**.
- A separate **worker process** picks the job up when it is due, checks it is still valid, enforces a per-sender hourly **rate limit**, sends the email via **Nodemailer** (Ethereal for testing, or a mock provider), and records the result.
- Failures are **retried with exponential backoff** (3 attempts). Every attempt is stored in an attempt-history table.

```
Client ──HTTP──> Express API ───────────> PostgreSQL (job state + attempts, via Prisma)
                     │
                     └──add delayed job──> Redis / BullMQ queue
                                                 │
                                                 v
                                           Worker process
                                             ├─ rate-limit check (Redis)
                                             ├─ send via SMTP / mock (Nodemailer)
                                             └─ update status + attempt history (PostgreSQL)
```

---

## 3. Final stack and key decisions

| Area | Choice | Notes |
|---|---|---|
| Language | TypeScript **5.x (pinned)** | TypeScript 7 broke `ts-node`; use `tsx` as the runner |
| Runtime | Node.js 20+ | |
| API | Express **5.x** | Async handler errors are forwarded to the error handler automatically, so no try/catch wrapper is needed |
| Validation | Zod 4.x | Used for request bodies, query params, and env vars |
| Database | PostgreSQL 16 | Source of truth |
| ORM | Prisma **6 (pinned)** | Classic setup. Delete the `prisma.config.ts` that `prisma init` creates |
| Queue | BullMQ 6.x + ioredis 6.x on Redis 7 | **Kafka was dropped** (overkill: BullMQ already gives delayed jobs, retries, concurrency) |
| Email | Nodemailer 10.x | Ethereal for testing; `mock` provider for dev/tests |
| Local infra | Docker Compose (Postgres + Redis) | |

Design decisions the agent should preserve:

1. **PostgreSQL is the source of truth; Redis is the execution mechanism.** The worker always re-reads the row before sending.
2. **BullMQ job id = EmailJob row id** (makes enqueueing idempotent, makes removal easy).
3. **API and worker are separate processes** sharing one code base.
4. **Rate limit is checked before claiming the job**, so deferral changes nothing in the database and does not burn a retry. Use `job.moveToDelayed(...)` + `throw new DelayedError()`.
5. **Status returns to `SCHEDULED` between retries**; only the final failed attempt sets `FAILED`.
6. **Worker claim accepts `SCHEDULED` and `PROCESSING`** so jobs recovered after a worker crash do not get stuck.
7. **Status + attempt record are written in one `prisma.$transaction`.**
8. **Cancellation is an atomic conditional update** (`updateMany where status = SCHEDULED`).
9. If enqueue fails at schedule time: mark the row `FAILED` with the reason and return **503**.

---

## 4. Data model (target schema)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum JobStatus {
  SCHEDULED
  PROCESSING
  SENT
  FAILED
  CANCELLED
}

model EmailJob {
  id        String         @id @default(uuid())
  recipient String
  subject   String
  body      String
  sendAt    DateTime
  status    JobStatus      @default(SCHEDULED)
  attempts  Int            @default(0)
  lastError String?
  sentAt    DateTime?
  createdAt DateTime       @default(now())
  updatedAt DateTime       @updatedAt
  history   EmailAttempt[]

  @@index([status, sendAt])
  @@index([recipient])
}

model EmailAttempt {
  id         String   @id @default(uuid())
  emailJobId String
  emailJob   EmailJob @relation(fields: [emailJobId], references: [id], onDelete: Cascade)
  attemptNo  Int
  success    Boolean
  response   String?
  error      String?
  createdAt  DateTime @default(now())

  @@index([emailJobId])
}
```

State machine: `SCHEDULED -> PROCESSING -> SENT`; `PROCESSING -> SCHEDULED` (retry pending); `PROCESSING -> FAILED` (last attempt); `SCHEDULED -> CANCELLED`; `SCHEDULED -> FAILED` (enqueue failed). `SENT`, `FAILED`, `CANCELLED` are terminal.

---

## 5. Target API

| Endpoint | Purpose |
|---|---|
| `GET /health` | Checks Postgres (and Redis from Phase 2) |
| `POST /api/emails/schedule` | Body: `recipient` (email), `subject` (1-200), `body` (1-100000), `sendAt` (date). 201 with job; 400 on validation error; 503 if enqueue fails |
| `GET /api/emails` | List, newest first. Query: `status`, `page` (default 1), `pageSize` (default 20, max 100). Returns `{ items, total, page, pageSize }` |
| `GET /api/emails/:id` | One job (with attempt `history` from Phase 3). 404 if missing |
| `POST /api/emails/:id/cancel` | 200 if cancelled; 409 if not found or no longer `SCHEDULED` |

---

## 6. Target folder structure

```
Email_Scheduler/
├── prisma/schema.prisma
├── scripts/create-ethereal-account.ts     # prints test SMTP credentials
├── src/
│   ├── config/   env.ts, prisma.ts, redis.ts
│   ├── queue/    emailQueue.ts
│   ├── routes/   emails.ts
│   ├── services/ mailer.ts, rateLimiter.ts
│   ├── worker/   index.ts
│   ├── app.ts
│   └── server.ts
├── .env  (never commit)
├── docker-compose.yml
├── package.json
└── tsconfig.json
```

Environment variables (validated with Zod in `src/config/env.ts`):

`PORT` (4000), `DATABASE_URL` (required), `REDIS_HOST` (localhost), `REDIS_PORT` (6379), `REDIS_PASSWORD`, `EMAIL_PROVIDER` (`smtp`|`mock`, default smtp), `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `WORKER_CONCURRENCY` (5), `JOB_ATTEMPTS` (3), `BACKOFF_DELAY_MS` (5000), `MAX_EMAILS_PER_HOUR` (100), `MIN_EMAIL_DELAY_MS` (200).

---

## 7. Environment facts and pitfalls already hit (do not repeat these)

**Working on the user's machine**

- Node project with `tsx watch` printing `hello` works.
- Docker Desktop works (`docker 29.8.2`, `compose v5.5.1`). Virtualization feature and WSL were enabled; Ubuntu got installed (unneeded, ignore).
- `docker compose up -d` started containers `scheduler-postgres` (port 5432) and `scheduler-redis` (port 6379).
- Prisma 6 and `@prisma/client` 6 are installed. `prisma init` was run (it creates `prisma.config.ts`, which must be deleted for the classic Prisma 6 setup).

**Pitfalls**

| Problem | Cause | Fix |
|---|---|---|
| `ts-node-dev` crash: `reading 'fileExists'` | TypeScript 7 installed | Pin `typescript@5`, use `tsx` |
| `EJSONPARSE` | Hand-edited `package.json` missing a comma | Use `npm pkg set scripts.x="..."` instead of hand-editing |
| esbuild `Unexpected "�"` | PowerShell `echo ... > file` writes **UTF-16** | `Set-Content -Path f -Value '...' -Encoding utf8`, or save as UTF-8 in VS Code |
| `Unknown command` from npm | Package name run as an npm command | `npx <tool>` or `npm run <script>` |
| `docker` not recognized | Not installed / old terminal | Install Docker Desktop, open a **new** terminal |
| Docker "Virtual Machine Platform not enabled" | Windows feature off | `Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform` in admin PowerShell, then **restart Windows** |
| `failed to connect to the docker API ... dockerDesktopLinuxEngine` | Docker Desktop not running | Open Docker Desktop, wait for engine, check `docker info` |
| npm errors from wrong folder | Running npm in `src` | Always run from the project root (where `package.json` is) |
| npm warns about blocked install scripts | New npm `allowScripts` behavior | `npm approve-scripts prisma @prisma/engines @prisma/client` (esbuild warning can be ignored) |

**PowerShell reminders:** `curl` is an alias for `Invoke-WebRequest`; use `Invoke-RestMethod` (or `curl.exe`). No bash heredocs. For JSON bodies use `@{...} | ConvertTo-Json`. A UTC ISO time 1 minute ahead: `(Get-Date).ToUniversalTime().AddMinutes(1).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")`. Create two folders: `mkdir src\config, src\routes`.

**Technical gotchas for later phases (verified)**

- BullMQ worker connections need `maxRetriesPerRequest: null` in the ioredis options.
- Retry backoff with `attempts: 3` and base 5000 ms waits about 5 s then 10 s. In the processor, a final attempt is `job.attemptsMade + 1 >= (job.opts.attempts ?? 1)`.
- BullMQ delayed-set scores are `timestamp_ms * 4096 + counter` (divide by 4096 if inspecting manually).
- Rate limiting: Lua script doing `INCR` + `EXPIRE` atomically; key `ratelimit:<sender>:<hourIndex>`; fixed hourly windows; deferred jobs move to the start of the next hour.
- `prisma generate` cannot download engines inside some sandboxes; that is an environment limitation, not a project problem.

---

## 8. Current status

| Phase | Description | Status |
|---|---|---|
| 0 | TypeScript project, Docker Desktop, Compose with Postgres + Redis, Prisma installed | **Done** on the user's machine |
| 1 | API + database (schedule, get by id, health, error handler) | **Code given and explained line by line; the user has not yet confirmed running it** |
| 2 | Redis + BullMQ queue (enqueue delayed job on schedule) | Not started |
| 3 | Worker (process, status transitions, attempt history, transactions, idempotency, graceful shutdown) with the mock mailer | Not started |
| 4 | Real delivery with Nodemailer + Ethereal | Not started |
| 5 | Reliability: retries/backoff config, rate limiting (Lua), `UnrecoverableError`, `DelayedError` | Not started |
| 6 | Remaining endpoints: list (pagination + status filter), cancel | Not started |
| 7 | Automated tests, reconciler, polish, README | Not started |

**First thing to do in the new chat:** ask the user to confirm Phase 1 works (health returns ok, schedule returns a `SCHEDULED` job, lookup returns the same job, bad email returns 400). Fix anything that fails before moving on.

---

## 9. The remaining plan, in detail

**Phase 2: Redis + BullMQ**
Install `bullmq ioredis`. Add `REDIS_*` to env. Create `src/config/redis.ts` (shared options with `maxRetriesPerRequest: null`, plus a shared client for health/rate limiting) and `src/queue/emailQueue.ts` (Queue `email-delivery`, default job options: attempts 3, exponential backoff 5000 ms, `removeOnComplete` 1 hour/1000 jobs, `removeOnFail` 7 days; `enqueueEmail(id, sendAt)` using `delay = max(0, sendAt - now)` and `jobId = id`). Update the schedule route: after inserting the row, enqueue; on failure mark the row `FAILED` and return 503. Extend `/health` to ping Redis. **Test:** schedule an email, confirm the job appears in Redis (`docker compose exec redis redis-cli zcard bull:email-delivery:delayed`).

**Phase 3: Worker**
Create `src/mailer` mock first (logs only). `src/worker/index.ts`: BullMQ `Worker` with concurrency from env. Processing order: load row (missing means `UnrecoverableError`); skip if `SENT`/`CANCELLED`; claim with `updateMany` where status in (`SCHEDULED`,`PROCESSING`) setting `PROCESSING` and incrementing `attempts`; send; on success one transaction sets `SENT` + `sentAt` + attempt record; on failure one transaction sets `FAILED` (last) or `SCHEDULED` (retry) + `lastError` + attempt record, then rethrow. Add `SIGINT`/`SIGTERM` graceful shutdown (`worker.close()`). Scripts: `dev:api`, `dev:worker`. Detail endpoint includes `history`. **Test:** run API and worker in two terminals; a job due in a few seconds becomes `SENT` with one successful attempt.

**Phase 4: Real email**
Add Nodemailer provider using env SMTP settings; script `scripts/create-ethereal-account.ts` prints credentials (`nodemailer.createTestAccount()`). **Test:** view the message at https://ethereal.email/messages.

**Phase 5: Reliability**
Retries/backoff already configured via queue options; test by pointing SMTP at an unreachable host (3 failed attempts, then `FAILED`). Add `src/services/rateLimiter.ts` (Lua script) and the worker check before claiming. **Test:** `MAX_EMAILS_PER_HOUR=1`, two due jobs: first `SENT`, second stays `SCHEDULED` with `attempts: 0`, deferred to the next hour.

**Phase 6: Endpoints**
`GET /api/emails` (Zod-validated `status`, `page`, `pageSize`; `findMany` + `count` in `Promise.all`) and `POST /api/emails/:id/cancel` (atomic conditional update, then `queue.remove(id)` in a `.catch`).

**Phase 7: Quality**
Tests (Vitest or Jest + Supertest against real Postgres/Redis with a separate test database and the mock mailer): API validation/create/list/cancel, rate limiter atomicity, worker success/retry/final-failure/idempotency/cancelled/deferral. Optional: a reconciler that re-enqueues overdue `SCHEDULED` rows missing from the queue (closes the insert-then-enqueue gap), Bull Board dashboard, README.

**Optional later:** authentication and per-user jobs, multiple senders table, campaigns/CSV import, analytics, structured logging (pino), Docker images for API/worker, deployment, a frontend.

---

## 10. Known limitations (be honest about these in docs and interviews)

- **Duplicate possible** if the worker crashes after SMTP accepted the message but before the database update. Delivery is at-least-once with duplicate protection, not exactly-once. Mitigation: provider idempotency keys.
- **Insert-then-enqueue gap:** a crash between the DB insert and the queue add leaves a `SCHEDULED` row that is never queued. Fix: reconciler or outbox pattern.
- **Fixed-window rate limiter** can allow up to double the limit around a window boundary; the counter counts attempts, not successes.
- **Single configured sender**, **no authentication**, **no automated tests yet**.
- Redis data loss would lose queued jobs (rows remain in PostgreSQL, hence the reconciler); enable Redis persistence in real deployments.

---

## 11. Phase 1 code (already given to the user)

Run from the project root. Install: `npm install express zod dotenv` and `npm install -D @types/express`. Script: `npm pkg set scripts.dev="tsx watch src/server.ts"`. Then `npx prisma migrate dev --name add-attempts` after putting the schema from section 4 in `prisma/schema.prisma`. `.env`:

```
DATABASE_URL="postgresql://scheduler:scheduler@localhost:5432/email_scheduler?schema=public"
```

`docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16
    container_name: scheduler-postgres
    environment:
      POSTGRES_USER: scheduler
      POSTGRES_PASSWORD: scheduler
      POSTGRES_DB: email_scheduler
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7
    container_name: scheduler-redis
    ports:
      - "6379:6379"

volumes:
  pgdata:
```

`src/config/env.ts`:

```ts
import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
});

export const env = schema.parse(process.env);
```

`src/config/prisma.ts`:

```ts
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
```

`src/routes/emails.ts`:

```ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";

export const emailsRouter = Router();

const scheduleSchema = z.object({
  recipient: z.string().email(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(100_000),
  sendAt: z.coerce.date(),
});

// POST /api/emails/schedule
emailsRouter.post("/schedule", async (req, res) => {
  const data = scheduleSchema.parse(req.body);
  const job = await prisma.emailJob.create({ data });
  res.status(201).json(job);
});

// GET /api/emails/:id
emailsRouter.get("/:id", async (req, res) => {
  const job = await prisma.emailJob.findUnique({
    where: { id: String(req.params.id) },
  });
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(job);
});
```

`src/app.ts`:

```ts
import express, { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { prisma } from "./config/prisma";
import { emailsRouter } from "./routes/emails";

export const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok" });
  } catch (err) {
    res.status(503).json({ status: "unhealthy", error: (err as Error).message });
  }
});

app.use("/api/emails", emailsRouter);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: "Validation failed", details: err.flatten() });
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});
```

`src/server.ts`:

```ts
import { app } from "./app";
import { env } from "./config/env";

app.listen(env.PORT, () => {
  console.log(`API listening on http://localhost:${env.PORT}`);
});
```

Phase 1 test (PowerShell, API running via `npm run dev`):

```powershell
Invoke-RestMethod http://localhost:4000/health

$body = @{
  recipient = "alice@example.com"
  subject   = "Hello"
  body      = "<p>Test</p>"
  sendAt    = (Get-Date).ToUniversalTime().AddMinutes(1).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
} | ConvertTo-Json

$job = Invoke-RestMethod -Method Post -Uri http://localhost:4000/api/emails/schedule -ContentType "application/json" -Body $body
$job
Invoke-RestMethod http://localhost:4000/api/emails/$($job.id)
```

Expected: `status ok`; a job with `status: SCHEDULED`; the same job from the lookup; and a `400` for an invalid recipient.

---

## 12. Other documents the user already has

- `Email_Scheduler_Project_Documentation.md/.pdf`: complete project documentation including the **full, type-checked reference source code for all phases** (section 16), tested end to end against real Redis and PostgreSQL with the mock provider (scheduling, delayed processing, validation, cancel, retries ending in `FAILED`, rate-limit deferral).
- `Email_Scheduler_Interview_Guide.md/.pdf`: 50 interview questions from easy to hard, with simple answers.

When building later phases, **reuse the reference code from the Project Documentation** instead of rewriting it, but still deliver it one phase at a time with line-by-line explanations.

---

## 13. Resume wording (only claim what has been built)

**Email Scheduler (Distributed Task Processing System)**

- Architected an email scheduling backend in TypeScript using BullMQ and Redis for delayed job execution and PostgreSQL (Prisma) for durable job state, with Express APIs for scheduling, listing, and cancelling emails.
- Implemented a dedicated worker with idempotent, transactional processing, automatic retries with exponential backoff, and per-attempt delivery history to ensure reliable delivery and full auditability.
- Built atomic per-sender hourly rate limiting with Redis Lua scripts and graceful shutdown handling, allowing concurrent workers to process jobs safely without duplicate sends.

Do not mention Docker unless the user asks. Only include bullets for features that actually exist in the user's code at the time.
