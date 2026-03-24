## Stick A Pin

Link: www.stickapin.app

### Daily Reflection via GitHub Actions

This repository includes a workflow at `.github/workflows/daily-reflection-cron.yml` that can trigger the daily reflection scheduler endpoint every 5 minutes.

#### 1) Add repository secrets

In GitHub → **Settings** → **Secrets and variables** → **Actions**, add:

- `APP_BASE_URL` (example: `https://www.stickapin.app`)
- `CRON_SECRET` (must match the `CRON_SECRET` environment variable configured in your deployed app)

#### 2) Enable workflow schedules

- Go to **Actions** and make sure workflows are enabled for the repository.
- The workflow runs on:
  - `schedule` (`*/5 * * * *`)
  - `workflow_dispatch` (manual run button; supports optional `base_url` input for a preview deployment URL)

#### 2.1) Important deployment note

The workflow calls a deployed URL. If your branch is not deployed on Vercel yet, use the manual workflow run and set `base_url` to a deployed preview URL, or rely on the default `APP_BASE_URL` secret (typically production).

If neither is configured, the workflow intentionally fails so misconfiguration is visible.

#### 3) Set the scheduler window for 5-minute ticks

Because GitHub Actions cannot run every minute, set:

- `DAILY_EMAIL_SCHEDULER_WINDOW_MINUTES=5`

in your runtime environment. This allows each tick to send when the current local time is within the 5-minute window after a user's chosen send time.

#### 4) Vercel cron limit compatibility

`vercel.json` is configured with a single once-per-day cron (`0 0 * * *`) so deployments remain compatible with Vercel Hobby cron limits.

GitHub Actions is the primary high-frequency scheduler (every 5 minutes). The daily Vercel cron acts as a low-frequency backup trigger.
