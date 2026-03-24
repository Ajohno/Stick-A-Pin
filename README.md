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
  - `workflow_dispatch` (manual run button)

#### 3) Set the scheduler window for 5-minute ticks

Because GitHub Actions cannot run every minute, set:

- `DAILY_EMAIL_SCHEDULER_WINDOW_MINUTES=5`

in your runtime environment. This allows each tick to send when the current local time is within the 5-minute window after a user's chosen send time.
