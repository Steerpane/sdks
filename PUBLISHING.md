# Publishing the first versions

The first versions (SDKs and CLI 0.1.0) were published on 2026-11-05. The numbered sections below document that initial release. CLI 0.1.1 adds browser sign-in and is a separate npm release; the SDK versions remain 0.1.0. Check registry versions before publishing. Publishing can't be undone: a version number can never be reused, and PyPI and npm keep the source readable for anyone.

CLI-only release: run the dry run, then `npm publish /tmp/steerpane-packages/steerpane-cli-0.1.1.tgz --access public` after CI and deployment pass. A main push deploys the application, not npm packages. npm authentication / two-factor approval is required unless trusted publishing has been configured on the public SDK repository.

**What publishing means.** The packages contain their full source, so anyone can read and reuse the SDK and CLI code under Apache-2.0. That is normal for a client library. The platform repo stays private, and the packages contain no server code, which the dry run checks. Nothing in the decision document conflicts with this licence: its commercial licence is for self-hosting the platform.

**Tokens never go in the repo.** Don't put them in `.npmrc` or `.pypirc` here, in `.env`, or in chat.

## Before you start

1. Two-factor login on, on both npmjs.com and pypi.org.
2. On npm, create the free **`steerpane` organization** (https://www.npmjs.com/org/create). `@steerpane/...` packages can only be published by the owner of that scope. If someone already took it, stop and tell me.
3. The default API address is `https://api.steerpane.app` (`DEFAULT_BASE_URL` in `python/src/steerpane/_client.py` and `node/src/client.ts`). It's built into each released version.
4. Check the names are still free. All five returned 404 on 2026-11-04.
   ```bash
   npm view @steerpane/sdk version; npm view @steerpane/cli version; npm view steerpane version
   curl -s -o /dev/null -w '%{http_code}\n' https://pypi.org/pypi/steerpane-sdk/json
   curl -s -o /dev/null -w '%{http_code}\n' https://pypi.org/pypi/steerpane/json
   ```

## 1. Dry run

This builds everything, prints every file that would ship, and checks versions, licences, and that no tests, server code or secrets are inside. It uploads nothing and needs no login.

```bash
python sdks/scripts/publish_dry_run.py --out /tmp/steerpane-packages
```

Read the file lists. Don't continue unless it ends with `All checks passed`.

The two placeholders are in `placeholders/`. They take the unscoped name `steerpane` on npm and on PyPI, which would otherwise be easy to mistake for ours. They only point to the real packages. The PyPI one installs a module called `steerpane_placeholder`, so it can't clash with `import steerpane` from `steerpane-sdk`.

## 2. npm

Publish the SDK first, because the CLI depends on it. Run the commands in order from the repo root. `npm login` opens a browser, and each publish asks for your two-factor code.

```bash
npm login
npm publish /tmp/steerpane-packages/steerpane-sdk-0.1.0.tgz --access public
npm publish /tmp/steerpane-packages/steerpane-cli-0.1.0.tgz --access public
npm publish /tmp/steerpane-packages/steerpane-0.0.1.tgz --access public
npm logout
```

## 3. PyPI

Create an API token at https://pypi.org/manage/account/token/. PyPI's first upload of a new name needs an account-wide token. Delete it after the upload and make per-project ones for later releases. Don't save it anywhere in this repo.

```bash
uvx twine upload /tmp/steerpane-packages/steerpane_sdk-0.1.0-py3-none-any.whl /tmp/steerpane-packages/steerpane_sdk-0.1.0.tar.gz
uvx twine upload /tmp/steerpane-packages/steerpane-0.0.1-py3-none-any.whl /tmp/steerpane-packages/steerpane-0.0.1.tar.gz
```

Twine asks for the credentials. The username is `__token__`, and the password is the token, pasted at the prompt.

## 4. Check what's live

In an empty folder, against any API you can reach:

```bash
npm view @steerpane/sdk version       # 0.1.0
npm view @steerpane/cli version       # 0.1.0
npm view steerpane version            # 0.0.1
npx @steerpane/cli@0.1.0 --version    # 0.1.0

uv run --no-project --with steerpane-sdk python -c "import steerpane; print(steerpane.__version__)"   # 0.1.0
```

`pip index versions steerpane` should show `0.0.1`.

## 5. Turn on the dashboard's install instructions

Set `PACKAGES_PUBLISHED` to `true` in `frontend/src/lib/packages.ts`. `no-phantom-claims.test.ts` follows the constant. Pushing to `main` deploys it. `/llms.txt` and `/skill.md` follow the same constant.

## Later releases

Bump the version in `pyproject.toml` and `_version.py`, and in `package.json` and `version.ts`, change the expected numbers in `scripts/publish_dry_run.py`, push, then push a tag matching the Python version, like `v0.1.1`. `.github/workflows/release.yml` tests and publishes, skipping anything already on its registry.

Set this up once, after the first manual publish. No tokens are stored:

- **PyPI:** on `steerpane-sdk`, Publishing, add a GitHub publisher: owner `Steerpane`, repository `sdks`, workflow `release.yml`.
- **npm:** on both `@steerpane/sdk` and `@steerpane/cli`, Settings, Trusted Publisher, add GitHub Actions with the same three values.

To stop people installing a bad release, `npm deprecate` it or yank it on PyPI. It can't be replaced under the same number.
