# ChargeFlow — EV Charging Intelligence

ChargeFlow is a full-stack EV charging workspace for India. It combines a React dashboard, an Express host, and a FastAPI recommendation service backed by the included station dataset.

## Production architecture

The Node server is the only public process. It serves the built React app, proxies `/python-api/*` to an embedded FastAPI process, and exposes the existing tRPC/OAuth infrastructure. The container includes Python 3 and installs the FastAPI dependencies during image build.

Recommendations are currently **dataset-backed heuristic estimates**. Occupancy is synthetic and reproducible until a live charger telemetry provider is connected; the UI labels the decision trace and service status accordingly.

## Required production configuration

Set the following as platform secrets or environment variables before deployment:

| Variable | Purpose |
| --- | --- |
| `CHARGEFLOW_SESSION_SECRET` | At least 32 random characters for signed sessions. |
| `CHARGEFLOW_ADMIN_EMAIL` / `CHARGEFLOW_ADMIN_PASSWORD` | Admin credentials; never use repository defaults. |
| `CHARGEFLOW_FRONTEND_URL` | The public origin, used for OAuth and CORS configuration. |
| `CHARGEFLOW_AUTH_DB_PATH` | A path backed by persistent storage if local registration/password recovery is enabled. |

Optional Google OAuth variables are documented in `.env.example` when working locally. Reset-email delivery is intentionally disabled until a real email provider is configured.

## Local development

```bash
pnpm install --frozen-lockfile
pnpm dev
```

The Node dev server starts the embedded Python service automatically. For a local account, register from `/login`; no demo credentials are committed.

## Verification

```bash
pnpm check
pnpm test
pnpm test:backend
pnpm build
```

The production image runs `pnpm run build` itself, serves `dist/public`, and listens on the managed `PORT` environment variable.

## Launch notes

The included SQLite auth store is appropriate for local development and a single persistent instance. For multi-instance production registration, migrate these auth endpoints to the project’s managed MySQL/TiDB database or attach persistent storage; Cloud Run’s local filesystem is not durable across instance replacement. The read-only station CSV remains packaged with the image.
