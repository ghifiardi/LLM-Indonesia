# Workshop release — build order and the one-behind build id

## Build order is not interchangeable

```bash
node tools/build-workshop-web.mjs     --base-url https://office.tantular.ai
node tools/build-workshop-package.mjs --base-url https://office.tantular.ai   # AFTER
cd dist/workshop-web
vercel link --yes --project workshop-web --scope gatra    # .vercel is wiped every time
vercel deploy --prod --yes
```

`build-workshop-web.mjs` begins by **wiping `dist/workshop-web`, including
`downloads/`**. Run the package build first and the wipe deletes the zips you
just made — the site then serves whatever was deployed previously, while your
local tree shows fresh ones.

That is not hypothetical. Two zips with the same filename and different
contents circulating is what made a workshop fail inconsistently: attendees
followed identical instructions and got different results, because they had
different artifacts. See `ea0ae0c`.

The wipe also deletes `.vercel`, so the project needs relinking on every
release. The ignore rule for `.vercel` therefore lives in
`tantular_office_addin/.gitignore`, not inside the build output where a wipe
would remove it (`35ec6d2`).

## The build id is always one commit behind HEAD — this is correct

`workshop-build.json` records the source commit the package was built **from**.
Committing the built zips creates a *new* commit, so the artifact inside can
never name the commit that contains it:

```
commit A   source change
commit B   built zips, whose workshop-build.json says "A"
```

Rebuilding at B stamps "B", and committing that produces C containing "B".
Chasing equality is an infinite regress. **The id naming the previous commit is
the design, not drift.**

To answer "which source produced this artifact?", read `sourceSha` and check
out that commit. The commit that *contains* the zip is always its child.

## Verifying a release

```bash
curl -sLO https://office.tantular.ai/downloads/tantular-workshop-mac.zip
unzip -q tantular-workshop-mac.zip -d /tmp/check
cat /tmp/check/workshop-build.json
```

Verify against the **published** zip, not the local one. Only that proves the
deploy carried what you built.

## What the build refuses to ship

`build-workshop-package.mjs` fails before zipping if:

- a shipped module imports a relative module that is not in the package,
  `./sibling` or `../src/...` alike (this is the `ERR_MODULE_NOT_FOUND` that
  broke a workshop twice — `a916adb`, then `src/chat/ollamaBridge.js`)
- a launcher calls `npm run X` / `npm start` with no such script
- a `package.json` script points at a file that is not shipped

The copy list is no longer hand-maintained: `copyModuleClosure()` walks the
imports of each entry point and ships everything reachable, so a new import in
a shipped tool is packaged automatically. Only reachable modules are copied —
`src/taskpane.html` stays out, and the dev server keeps correctly detecting
that it runs as a bridge, with the pane served from the web. The check above
then re-derives the same graph from the SHIPPED files, as an independent
reading rather than a restatement of the copier.

## Attendee-facing identity

- `README-WORKSHOP.txt` line 2 — visible in a screenshot
- `npm run doctor` — first two lines, before any diagnostic
- absent `workshop-build.json` means the source repo is running, not a package

## Released

| Build id | Deployed | Notes |
|---|---|---|
| `2026-08-17.b9d1f9b` | 2026-08-17 | first release carrying build id + package verification |
| `2026-08-17.c26c01e` | 2026-08-17 | support page aligned: doc-server instruction, build tag, doctor-first troubleshooting, Tantular/Qwen3.5 relationship |
