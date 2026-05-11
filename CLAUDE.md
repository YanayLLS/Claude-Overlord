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
