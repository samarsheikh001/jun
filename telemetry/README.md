# Jun telemetry collector

Receives desks' anonymous daily pings (T-20, D-151; what they contain: the main README's "Anonymous usage ping" and `shared/telemetry.ts`). Run by the Jun project at `telemetry.jun.so`. It isn't part of a desk, and the Deploy button doesn't deploy it.

It accepts only the exact shape `readPing` allows, keeps one row per desk per day, and stores no IP address or header.

Setup, once, from this folder:

```sh
npx wrangler d1 create jun-telemetry          # put the id in wrangler.jsonc
npx wrangler d1 execute jun-telemetry -c wrangler.jsonc --remote --file schema.sql
npx wrangler secret put STATS_KEY -c wrangler.jsonc
npx wrangler deploy -c wrangler.jsonc
```

Pass `-c wrangler.jsonc` every time: without it, Wrangler also finds the desk's build output one folder up and refuses to run.

Stats: `https://telemetry.jun.so/?key=<STATS_KEY>`. Without the key, it answers 404.

## Hosted-Jun waitlist

The same Worker takes jun.so's "Want us to host it?" form: `POST /v1/waitlist` with `{ email, source }`, only from jun.so's origins (CORS). Emails go to their own D1 database, `jun-waitlist` (`waitlist.sql`), never into the pings' database; a hidden `website` field catches bots, and signing up twice answers the same. The stats page lists them.

```sh
npx wrangler d1 execute jun-waitlist -c wrangler.jsonc --remote --file waitlist.sql
```

## Changing the ping

Before a desk release adds a field to the ping, update `readPing` and deploy this collector first. Otherwise the collector refuses the new pings.
