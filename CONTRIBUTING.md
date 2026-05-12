# Contributing to Flash POS

Thanks for helping improve Flash POS. This guide keeps contributions easy to
review and safe for a payment-focused mobile app.

## Before You Start

1. Check the issue tracker for an existing issue.
2. Comment on the issue if you plan to work on it, especially for bounty work.
3. Keep credentials, API keys, wallet data, screenshots with private account
   information, and production payment details out of commits and PR comments.

## Local Setup

```bash
git clone https://github.com/lnflash/flash-pos.git
cd flash-pos
yarn install
cp .env.example .env
yarn start
```

Use `yarn android` or `yarn ios` from a second terminal to run the app. NFC,
printing, and production payment flows should be tested on physical devices
when your change touches those areas.

## Development Workflow

1. Create a focused branch from `main`.
2. Make the smallest change that solves the issue.
3. Add or update docs when behavior, setup, or operator expectations change.
4. Run the relevant checks:

```bash
yarn test
yarn lint
```

For Android release-sensitive changes, also smoke-check:

```bash
yarn apk-android
```

## Pull Request Checklist

- Describe the user-visible change.
- Link the issue being fixed.
- Include screenshots or screen recordings for UI changes.
- Note the test commands you ran.
- Call out any hardware-tested flows, such as NFC cards or printers.
- Explain any follow-up work that is intentionally left out of scope.

## Bounty Notes

Some issues may include Lightning or other reward terms. Eligibility depends on
the issue description and maintainer review. Do not include payment addresses,
API secrets, private keys, or other sensitive payment details in the repository.
Share payout details only through the maintainer-approved private process.
