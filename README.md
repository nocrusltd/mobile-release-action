# Nocrus Mobile Release

Build an Expo app and submit it to TestFlight or Google Play from your own
GitHub Actions workflow. Requires a licence from Nocrus
(licensing@nocrus.co.uk).

## Use

```yaml
jobs:
  ios:
    runs-on: macos-15
    permissions:
      id-token: write   # proves to the licensing service which organisation this run belongs to
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - uses: nocrusltd/mobile-release-action@v1
        with:
          licence-key: ${{ secrets.NOCRUS_LICENCE_KEY }}
          platform: ios
          submit: true
        env:
          EXPO_TOKEN: ${{ secrets.EXPO_TOKEN }}
          EXPO_APPLE_ID: ${{ secrets.EXPO_APPLE_ID }}
          EXPO_APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.EXPO_APPLE_APP_SPECIFIC_PASSWORD }}

  android:
    runs-on: ubuntu-24.04
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - uses: nocrusltd/mobile-release-action@v1
        with:
          licence-key: ${{ secrets.NOCRUS_LICENCE_KEY }}
          platform: android
          submit: true
        env:
          EXPO_TOKEN: ${{ secrets.EXPO_TOKEN }}
          GOOGLE_SERVICE_ACCOUNT_JSON: ${{ secrets.GOOGLE_SERVICE_ACCOUNT }}
```

Your project needs an `eas.json` with a build profile and, to submit, a
submit profile (`production` unless you set `profile`).

## Inputs

| Input | Default | |
| --- | --- | --- |
| `licence-key` | required | Your licence key, from an Actions secret. |
| `platform` | required | `ios` or `android`. |
| `profile` | `production` | The eas.json build and submit profile. |
| `submit` | `false` | Submit the build to TestFlight or Google Play. |
| `pre-build` | | A shell command to run before the native project is generated. |
| `working-directory` | `.` | The Expo project directory. |
| `output-dir` | `build` | Where the built file is written. |
| `eas-cli-version` | `latest` | `latest`, a version, or empty to use the eas already installed. |
| `upload-artifact` | `true` | Upload the build as the artifact `<platform>-build`. |

Output: `artifact-path`, the built `.ipa`, `.aab` or `.apk`.

## What it does

1. Checks the secrets and settings the run will need before building, so a
   missing one fails in seconds.
2. For iOS, selects the Xcode version your `eas.json` build image names.
3. Generates the native project fresh and builds on your runner
   (`eas build --local`).
4. Submits to TestFlight or Google Play if `submit` is true.

For Android, set `submit.<profile>.android.serviceAccountKeyPath` in
`eas.json`; the key from `GOOGLE_SERVICE_ACCOUNT_JSON` is written there for
the submit step and removed afterwards.

## Your credentials and our service

Your Expo, Apple and Google credentials stay on your runner. They are passed
to Expo's `eas` command and are never sent to Nocrus.

Each run contacts `licensing.nocrus.co.uk` once, with your licence key and a
short-lived identity token GitHub issues for the run. That token names the
repository and organisation; it grants no access to your code. The service
returns a signed licence file and the release tool. Both are cached, so if
the service cannot be reached a run continues on a cached licence for up to
72 hours.

A licence covers one GitHub organisation and a set number of its
repositories. It works on github.com; GitHub Enterprise Server is not
supported.

## Support

licensing@nocrus.co.uk
