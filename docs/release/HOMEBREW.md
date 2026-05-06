# Homebrew Release Runbook

This repo is packaged for Homebrew through the separate
`aicw-io/homebrew-tap` repository. In the EE workspace, that tap is checked out
as the `homebrew-tap/` submodule.

## Current Install Path

Users install the stable release from the tap:

```bash
brew install aicw-io/tap/aicw-video
```

Users can install the development build from the upstream `main` branch:

```bash
brew install --HEAD aicw-io/tap/aicw-video
```

## Publish To npm

Publish from the open-source package checkout:

```bash
cd core
npm login
npm whoami
npm ci
npm run build
npm pack --dry-run
npm publish --access public
```

Notes:

- `aicw-video` is an unscoped public package name. `--access public` is harmless
  for unscoped packages and required if the package ever becomes scoped.
- npm package versions are immutable. Once `aicw-video@1.0.0` is published, that
  exact version cannot be published again.
- npm may require a 2FA one-time password during `npm publish`. If prompted, use
  the current code from the npm account authenticator.
- `npm pack --dry-run` is the packaging check. Confirm it includes `dist/`,
  `config.json`, `README.md`, `LICENSE`, `NOTICE.md`, and release docs.

## Tag The Source Release

After npm publish succeeds:

```bash
git tag v1.0.0
git push origin v1.0.0
```

Use the version from `package.json` for the tag.

## Update The Tap Formula

Get the npm tarball URL and SHA-256:

```bash
npm view aicw-video@1.0.0 dist.tarball
curl -Ls https://registry.npmjs.org/aicw-video/-/aicw-video-1.0.0.tgz | shasum -a 256
```

Then update `homebrew-tap/Formula/aicw-video.rb` from HEAD-only to stable:

```ruby
url "https://registry.npmjs.org/aicw-video/-/aicw-video-1.0.0.tgz"
sha256 "REPLACE_WITH_SHA256"
version "1.0.0"

head "https://github.com/aicw-io/aicw-video.git", branch: "main"
```

Keep the `head` line so development installs continue to work:

```bash
brew install --HEAD aicw-io/tap/aicw-video
```

## Validate Locally

From the tap checkout, register the local checkout as the tap:

```bash
cd homebrew-tap
ruby -c Formula/aicw-video.rb
brew tap aicw-io/tap "$PWD"
brew audit --strict aicw-io/tap/aicw-video
brew install --build-from-source aicw-io/tap/aicw-video
aicw-video doctor
```

For a development install:

```bash
brew install --HEAD aicw-io/tap/aicw-video
```

## Release Order

1. Merge the open-source `core/` changes.
2. Publish `aicw-video` to npm.
3. Tag and push the matching source release.
4. Update `homebrew-tap/Formula/aicw-video.rb` with the npm tarball URL and
   SHA-256.
5. Test `brew install aicw-io/tap/aicw-video`.
6. Push the tap update.
