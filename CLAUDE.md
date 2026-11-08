# Overlord — Project Rules

## Release Versioning

Every commit to `master` that will be pushed must bump the version in `package.json`.

- Use semver: `major.minor.patch`
- Bug fixes / small UI tweaks: bump **patch**
- New features / significant changes: bump **minor**
- Breaking changes: bump **major**

Before committing to master, always:
1. Bump version in `package.json`
2. Include the version bump in the same commit

This ensures every push to master creates a valid GitHub release via electron-builder auto-update.

## Local API coverage

Other programs integrate with Overlord through the local API (`api-core.js`, `api-server.js`, `docs/local-api.md`). Every new feature must work through it, in the same change as the feature:

1. **Actions and reads**: anything a user can do or see in the UI gets a tool in `TOOLS` (with its handler in `HANDLERS`). Reach the feature through the `host` object that main.js builds in `apiHost()`; never duplicate its logic in api-core.js.
2. **State changes**: anything an integration would want to react to (a new agent state, a new kind of message, something that now waits on the user) gets a row in `EVENTS`, mapped from the renderer message main.js already sends.
3. **Discovery**: `overlord_capabilities` lists `TOOLS` and `EVENTS` as they are, so steps 1–2 make the feature discoverable. A new switch that changes what an integration sees goes in `features()` in `apiHost()`.
4. **Docs and tests**: add the tool or event to `docs/local-api.md` (the reference) and `docs/integrating-with-overlord.md` (the brief handed to integrating agents), and add a test in `api-core.test.js`. The test `docs/local-api.md documents every tool and every event type` fails when either file misses one.
5. **Compatibility**: tools and events are a contract. Add new arguments as optional and new event fields freely. Never rename or remove a tool, event or field, and never change what one means, without bumping `API_VERSION` in api-core.js and saying so in the commit message.

A feature that deliberately stays out of the API (purely visual, such as a theme or a layout) says so in its commit message.
