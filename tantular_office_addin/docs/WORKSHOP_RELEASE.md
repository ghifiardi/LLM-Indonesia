# Workshop release — build order and the one-behind build id

## Use the release command

```bash
npm run release:workshop -- --base-url https://office.tantular.ai            # build + smoke check
npm run release:workshop -- --base-url https://office.tantular.ai --deploy   # ...and publish
```

It owns the order, refuses a dirty tree (so the artifact names a commit), and
fails if any file the support page links to is missing or zero-length.

On 2026-08-27 `/support` served a 200 while every download link on it returned
404: the web build ran, the package build did not follow, and the empty output
was deployed. `downloads/` is gitignored by design, so git had nothing to
report and the site looked healthy until someone clicked a button. The smoke
check exists to make that failure impossible to deploy.

To release without disturbing in-flight work, build from a clean worktree:

```bash
git worktree add --detach /tmp/rel <commit>
cd /tmp/rel/tantular_office_addin
npm run release:workshop -- --base-url https://office.tantular.ai
cp -R <old-dist>/.vercel dist/workshop-web/.vercel   # same project
cd dist/workshop-web && vercel deploy --prod --yes
```

Always verify the **live URLs** afterwards, not the local files.

## The underlying order, if you run the builds by hand

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
