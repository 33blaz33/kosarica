# Project context

Last reviewed: 2026-11-20

## Purpose

`kosarica.top` is a Slovenian grocery price tracking app. Users can save products from supported online shops, compare equivalent products, track price history, and receive email notices when tracked prices change.

## Stack and commands

- Node.js with ES modules (`"type": "module"`).
- Express 4 serves EJS templates and JSON API routes.
- MySQL access is intended through `mysql2`.
- Product pages are scraped with `cheerio` and `undici`; periodic tasks use `node-cron`; email uses `nodemailer`.
- `npm run dev` starts `nodemon app.js`; `npm start` runs `node app.js`.
- `package-lock.json` is present; use `npm ci` for a reproducible dependency install when deploying from this lockfile.
- `.env.example` documents the runtime environment variable names with no credentials; the local `.env` is ignored by Git.
- `Dockerfile`, `.dockerignore`, and `compose.yaml` provide a production container build and TrueNAS Custom App YAML starting point. Compose uses the mutable `latest` tag published by the workflow so TrueNAS image-digest checks can detect refreshed images. It maps host port 31876 to the app's internal port 4000. The image health check sends the forwarded HTTPS header expected by the app's production redirect. Compose expects an externally reachable MySQL database and a published image; database initialization is not included because the schema is absent.
- `.github/workflows/publish-image.yml` builds and publishes versioned and `latest` images to GHCR whenever `main` changes, using GitHub Actions' `GITHUB_TOKEN`. It adds the OCI source label linking the package to this repository.
- No test, lint, or build scripts are currently declared in `package.json`.

## Structure and flow

- `app.js` configures Express, cookie sessions, EJS, page routes, `/health`, `/api/scrape`, the `/api` router, and static serving from `public/`. It starts the scheduler after the server listens.
- The shared footer displays the app version from `package.json` via `app.locals.appVersion`.
- `db.js` creates a `mysql2/promise` connection pool using `DB_HOST`, `DB_USER`, `DB_PASS`, and `DB_NAME` environment variables. It loads `.env` from the project root.
- Email unsubscribe links use the `DOMAIN` environment variable.
- `routes/routes.js` contains the JSON API for product tracking, registration/login/logout, profile, product extraction, email unsubscribe, and the cheapest tracked equivalent overview. Authenticated endpoints use the session user.
- `routes/scrapper.js` extracts product details and prices for Mercator Online, SPAR, dm, and Mimovrste. Hofer is classified as a store on save, but has no corresponding extractor in the inspected code.
- `jobs/scheduler.js` exports price refresh and email notification jobs and supports direct invocation with `refresh` or `mail` arguments. Its in-process cron schedule definitions are currently commented out; the file has cPanel cron execution notes.
- `views/pages/` contains EJS pages for home, basket, about, login, register, profile, and overview. Shared EJS pieces are in `views/partials/`.

## Data model inferred from SQL

The app expects MySQL tables named `user`, `product`, `product_history`, and `product_secondary`. `product_secondary` associates products/equivalents with users and identifies a main product by a self-reference. Product rows are shared by URL; price observations are kept in `product_history`. The schema and constraints are not present in the inspected files, so details such as indexes and column types remain unverified.

## Current checkout observations

- `db.js` is present and configures a MySQL connection pool from environment variables. The SQL schema is still not present in the inspected checkout, so indexes and column definitions remain unverified.
- `.htaccess` contains CloudLinux Passenger settings for a cPanel deployment, including an app root, Node.js binary path, and `app.js` startup file. These paths are deployment-host-specific and may need adjustment on another hosting account.
- Templates reference `/style.css` and several `/js/*.js` files. The `public/` directory is now present and contains the referenced stylesheet and JavaScript assets.
- No `README` or existing `AGENTS.md` was found in the visible project files.
- The project directory is not a Git repository in the current checkout, so file history/status could not be reviewed.
- `.env` exists. Its contents are intentionally not recorded here; keep credentials and secrets out of project notes and chat.
- `tmp/restart.txt` exists as an empty Passenger restart trigger file. `.well-known/acme-challenge/` is present for certificate challenge files. `stderr.log` is present; its contents have not been inspected.
- Some source comments and user-facing strings appear to have character-encoding/mojibake issues. Verify the intended text before editing those strings.
- The Mimovrste extractor can return `null` when it cannot obtain a catalog code from `span[data-sel='catalog-number']` or cannot find a product variant in its GraphQL response. `/api/extract` now converts null extraction results into a clear 422 response and detects Cloudflare challenge responses using `cf-mitigated: challenge` or the observed challenge HTML signature. Product-add and comparison forms display server error messages.
- A user-provided Mimovrste GraphQL cURL request was attempted from this environment. After a Windows certificate revocation-check issue was bypassed while retaining certificate validation, Mimovrste returned a Cloudflare “Just a moment...” HTML challenge instead of GraphQL JSON. This confirms the request was challenged here, not why the user's original app request fails.

## Working notes

- Preserve the existing Express/EJS structure unless a requested feature calls for a larger change.
- Before changing persistence behavior, inspect the actual database module and schema if they become available.
- Before changing browser behavior or styling, inspect the actual files under `public/` if they become available.
- Update this file when verified project structure, architecture, commands, or important behavior changes.
