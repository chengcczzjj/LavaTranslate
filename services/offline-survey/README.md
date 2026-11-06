# Offline survey service

Public results: https://lavatranslate-offline-votes.cracker111.chatgpt.site
Site ID: `appgprj_6aed8503c7d88191b1255f99b40631dc`
Initial deployed source: `be286fb5af89926a2b01314f834c09782507c0ca` (Sites version 1).

The Sites-hosted Vinext Worker calls `votes(request, env.DB)` for `/api/votes`.
`votes.ts` mirrors the deployed `lib/votes.ts`. `schema.sql` is its initial D1 migration.
The full Site source, lockfile and build configuration are stored in its managed Sites source repository. Use the Sites skill with this existing project ID to open/update it; do not create another Site. Preserve public access and the `DB` binding. Run the D1 migration generator for future schema changes and deploy through Sites.

Only anonymous installation hashes are stored. GET exposes aggregate count and threshold (11). POST requires a valid UUID and a short, expiring SHA-256 proof bound to that installation and campaign. The unique primary key makes concurrent requests/retries idempotent. There are no public deletion or administration endpoints. No application secret is embedded in the desktop app. This is an interest survey; reinstalling/resetting app data can generate another identifier, so it is not strict person-level deduplication.

Run `node --test scripts/offline-survey.test.mjs` from the desktop repository. Test production with GET or invalid POST requests only; use local D1 for successful test votes to avoid polluting real counts.
