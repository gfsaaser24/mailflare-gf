<p align="center">
  <img src="/public/icon-96.png" alt="Mailflare" width="72" />
</p>

# Mailflare

Mailflare is a self-hosted email inbox for custom domains, built on Cloudflare.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hieunc229/mailflare)

![Mailflare inbox](/screenshot.png)

## What you can do

- Connect domains and set up Cloudflare Email Routing from the dashboard.
- Create personal and shared mailboxes with delegated access.
- Send and receive email with attachments, rich formatting, signatures, and automatic replies.
- Organize mail with search, custom folders, stars, snoozing, archive, spam, and trash.
- Create routing rules to store, forward, reject, or categorize incoming messages.
- Get real-time inbox updates and new-message notifications.
- Import and export mail, manage contacts, and block unwanted senders.
- Manage accounts, permissions, API keys, webhooks, audit logs, and database backups.

## How it works

Mailflare runs in your Cloudflare account. Email Routing delivers incoming messages to the app, while Cloudflare's email service handles outgoing messages. Your mail data stays in your own D1 database and attachments are stored in your own R2 bucket.

## How much does it cost?

You can setup Mailflare and receive email for free

A [Paid Worker](https://developers.cloudflare.com/workers/platform/pricing/) plan ($5/month) is required to send email (and it's recommend to have a smooth experience)

## Deploy

The easiest way to get started is with the **Deploy to Cloudflare** button above. You will need:

- A Cloudflare account.
- A domain managed by Cloudflare.
- A Cloudflare API token that Mailflare can use to configure email routing.

After deployment, open your Mailflare URL and follow the first-run setup. The setup checks your Cloudflare configuration, creates the initial account, and helps you connect your first domain.

See the [deployment guide](docs/deployment.md) for required permissions, manual deployment, backups, updates, and custom Worker names.

## Local development

```bash
cp .dev.vars.example .dev.vars
npm install
npm run db:migrate:local
npm run dev
```

Add your Cloudflare credentials to `.dev.vars`, then open [http://localhost:3000](http://localhost:3000). For sample local data, run `npm run db:seed` while the development server is running.

## Documentation

- [Deployment and configuration](docs/deployment.md)
- [API and integrations](docs/api.md)
- [Troubleshooting](docs/troubleshooting.md)

## License

See [LICENSE](LICENSE).
